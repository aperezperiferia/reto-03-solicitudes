import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChatMessage, LlmAdapter, ToolDefinition } from "./llm/adapter.js";
import { proveedorTools, type ToolContext } from "./tools/proveedor.js";

export type VisibleToolCall = { name: string; arguments: Record<string, unknown>; summary: string };
type Tool = (typeof proveedorTools)[keyof typeof proveedorTools];
type ToolName = keyof typeof proveedorTools;

function jsonType(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodArray) return { type: "array", items: jsonType(schema.element) };
  if (schema instanceof z.ZodObject) return schemaFor(schema);
  return {};
}

function schemaFor(tool: z.AnyZodObject): Record<string, unknown> {
  const shape = tool.shape as Record<string, z.ZodTypeAny>;
  const properties = Object.fromEntries(Object.entries(shape).map(([name, schema]) => [name, jsonType(schema)]));
  const required = Object.entries(shape).filter(([, schema]) => !schema.isOptional()).map(([name]) => name);
  return { type: "object", properties, required, additionalProperties: false };
}

function summarize(value: unknown): string {
  return JSON.stringify(value);
}

export function providerTools(): ToolDefinition[] {
  return Object.entries(proveedorTools).map(([name, tool]) => ({ name: `proveedor_${name}`, description: tool.description, schema: schemaFor(z.object(tool.args).strict()) }));
}

function findTool(name: string): [ToolName, Tool] | undefined {
  if (!name.startsWith("proveedor_")) return undefined;
  const key = name.slice("proveedor_".length) as ToolName;
  return key in proveedorTools ? [key, proveedorTools[key]] : undefined;
}

async function callTool(name: string, rawArguments: string, ctx: ToolContext, visible: VisibleToolCall[]): Promise<string> {
  const found = findTool(name);
  if (!found) return JSON.stringify({ ok: false, error: "Herramienta no autorizada" });
  if (name === "proveedor_simular_envio") return JSON.stringify({ ok: false, error: "La simulación de envío solo se ejecuta tras la confirmación humana explícita del siguiente turno." });
  let raw: unknown;
  try { raw = JSON.parse(rawArguments); } catch { return JSON.stringify({ ok: false, error: "Argumentos de herramienta inválidos" }); }
  const [key, tool] = found;
  const parsed = z.object(tool.args).strict().safeParse(raw);
  if (!parsed.success) return JSON.stringify({ ok: false, error: "Argumentos de herramienta inválidos", details: parsed.error.issues.map((issue) => issue.path.join(".")) });
  const output = await tool.execute(parsed.data as never, ctx);
  let result: unknown;
  try { result = JSON.parse(output); } catch { result = { ok: false, error: "Respuesta de herramienta inválida" }; }
  visible.push({ name: `proveedor_${key}`, arguments: parsed.data, summary: summarize(result) });
  return JSON.stringify(result);
}

export async function runLlmAgent(params: { adapter: LlmAdapter; directory: string; history: ChatMessage[]; message: string; maxIterations: number; }): Promise<{ reply: string; history: ChatMessage[]; toolCalls: VisibleToolCall[] }> {
  const prompt = await readFile(path.join(params.directory, "agent", "prompt.md"), "utf8");
  const messages: ChatMessage[] = [...params.history, { role: "user", content: params.message }];
  const visible: VisibleToolCall[] = [];
  const ctx = { directory: params.directory, sessionId: "llm" };
  for (let iteration = 0; iteration < params.maxIterations; iteration += 1) {
    const response = await params.adapter.enviar(prompt, messages, providerTools());
    if (!response.toolCalls.length) {
      const reply = response.content || "No recibí una respuesta del modelo.";
      return { reply, history: [...messages, { role: "assistant", content: reply }], toolCalls: visible };
    }
    messages.push({ role: "assistant", content: response.content || "Solicito herramientas." });
    for (const toolCall of response.toolCalls) {
      const output = await callTool(toolCall.name, toolCall.arguments, ctx, visible);
      messages.push({ role: "tool", content: output, toolCallId: toolCall.id, toolName: toolCall.name });
    }
  }
  const reply = "Se alcanzó el máximo de iteraciones del agente antes de completar la solicitud.";
  return { reply, history: [...messages, { role: "assistant", content: reply }], toolCalls: visible };
}
