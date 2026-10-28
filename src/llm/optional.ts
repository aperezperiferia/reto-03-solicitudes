import { GoogleGenAI, type Content, type Part } from "@google/genai";
import OpenAI from "openai";
import type { ChatMessage, LlmAdapter, LlmResponse, ToolDefinition } from "./adapter.js";

const timeoutMs = 15_000;

export class ProviderUnavailableError extends Error {}

function parsedToolCalls(output: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>): LlmResponse["toolCalls"] {
  return output.flatMap((item) => item.type === "function_call" && item.call_id && item.name && item.arguments
    ? [{ id: item.call_id, name: item.name, arguments: item.arguments }]
    : []);
}

export class OpenAiLlm implements LlmAdapter {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async enviar(systemPrompt: string, messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmResponse> {
    const client = new OpenAI({ apiKey: this.apiKey, timeout: timeoutMs, maxRetries: 0 });
    const input = [
      { role: "system" as const, content: systemPrompt },
      ...messages.map((message) => message.role === "tool"
        ? { type: "function_call_output" as const, call_id: message.toolCallId ?? "unknown", output: message.content }
        : { role: message.role, content: message.content })
    ] as Parameters<typeof client.responses.create>[0]["input"];
    try {
      const response = await client.responses.create({
        model: this.model,
        input,
        tools: tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.schema, strict: true }))
      });
      return { content: response.output_text, toolCalls: parsedToolCalls(response.output) };
    } catch {
      throw new Error("No fue posible contactar OpenAI. Verifique configuración y red.");
    }
  }
}

export class GeminiLlm implements LlmAdapter {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async enviar(systemPrompt: string, messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmResponse> {
    const client = new GoogleGenAI({ apiKey: this.apiKey });
    const contents: Content[] = messages.flatMap<Content>((message) => {
      if (message.role === "tool") {
        return [{ role: "user" as const, parts: [{ functionResponse: { id: message.toolCallId, name: message.toolName ?? "unknown", response: { output: JSON.parse(message.content) } } }] }];
      }
      if (message.role === "assistant") {
        const parts: Part[] = [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.functionCalls ?? []).map((call) => ({ functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) } }))
        ];
        return parts.length ? [{ role: "model" as const, parts }] : [];
      }
      return [{ role: "user" as const, parts: [{ text: message.content }] }];
    });
    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.schema })) }]
        }
      });
      return {
        content: response.text ?? "",
        toolCalls: (response.functionCalls ?? []).flatMap((call, index) => call.name ? [{ id: call.id ?? `gemini-${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) }] : [])
      };
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message.replace(/AIza[\w-]+/g, "[clave oculta]");
        if (/API key|API_KEY|unauthenticated|invalid.*key/i.test(message)) throw new Error("Gemini rechazó la clave API. Verifica que esté activa y autorizada para Gemini Developer API.");
        if (/high demand|unavailable|503|fetch|network|timeout|ECONN/i.test(message)) throw new ProviderUnavailableError("Gemini no está disponible temporalmente.");
        if (/model|not found|404/i.test(message)) throw new Error(`Gemini no encontró o no permite el modelo configurado (${this.model}). Verifica el modelo disponible en tu proyecto.`);
        if (/quota|rate|429/i.test(message)) throw new Error("Gemini rechazó la solicitud por cuota o límite de uso. Revisa la cuota de tu proyecto.");
        if (/403|permission/i.test(message)) throw new Error("Gemini denegó permisos a esta clave. Habilita Gemini Developer API o crea una clave del proyecto correcto.");
      }
      throw new Error("Gemini no pudo procesar la solicitud. Revisa la configuración del proveedor.");
    }
  }
}
