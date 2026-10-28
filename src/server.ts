import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runLlmAgent, type VisibleToolCall } from "./agent.js";
import type { ChatMessage, LlmAdapter } from "./llm/adapter.js";
import { GeminiLlm, OpenAiLlm, ProviderUnavailableError } from "./llm/optional.js";
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio, type ToolContext } from "./tools/proveedor.js";

type ToolCall = VisibleToolCall;
type Session = { history: ChatMessage[]; pendingSendCase?: string };
type Provider = "deterministic" | "openai" | "gemini";
const sessions = new Map<string, Session>();
const directory = process.cwd();
const maxMessages = Number(process.env.MAX_SESSION_MESSAGES ?? 60);
const maxIterations = Math.max(1, Number(process.env.MAX_AGENT_ITERATIONS ?? 25));
const chatSchema = z.object({ sessionId: z.string().min(1), message: z.string().min(1).max(4000) });
const tools = { proveedor_leer_solicitud: leer_solicitud, proveedor_mapear_campos: mapear_campos, proveedor_generar_formulario: generar_formulario, proveedor_armar_paquete: armar_paquete, proveedor_simular_envio: simular_envio } as const;

function configuredProvider(): Provider {
  const value = process.env.LLM_PROVIDER ?? "deterministic";
  if (value === "deterministic" || value === "openai" || value === "gemini") return value;
  throw new Error("LLM_PROVIDER debe ser deterministic, openai o gemini");
}

function createAdapter(provider: Provider): LlmAdapter | undefined {
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY es obligatoria cuando LLM_PROVIDER=openai");
    return new OpenAiLlm(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
  }
  if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY es obligatoria cuando LLM_PROVIDER=gemini");
    return new GeminiLlm(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? "gemini-flash-latest");
  }
}

function send(res: import("node:http").ServerResponse, code: number, body: unknown): void { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function caseFrom(text: string): string | undefined { return text.match(/(?:caso\s+)?["']?([a-z]{2}-[a-z0-9-]+)["']?/i)?.[1]; }
function summarize(value: unknown): string { const raw = JSON.stringify(value); return raw.length > 400 ? `${raw.slice(0, 397)}...` : raw; }
async function invoke<K extends keyof typeof tools>(name: K, args: Parameters<(typeof tools)[K]["execute"]>[0], ctx: ToolContext, calls: ToolCall[]): Promise<Record<string, unknown>> { const response = JSON.parse(await tools[name].execute(args as never, ctx)) as Record<string, unknown>; calls.push({ name, arguments: args as Record<string, unknown>, summary: summarize(response) }); return response; }
async function processCase(caso: string, ctx: ToolContext, calls: ToolCall[]): Promise<{ reply: string; needsConfirmation: boolean }> {
  const solicitud = await invoke("proveedor_leer_solicitud", { caso }, ctx, calls); if (!solicitud.ok) return { reply: `No pude leer el caso ${caso}: ${String(solicitud.error)}`, needsConfirmation: false };
  const data = solicitud.data as { campos: Array<{ etiqueta: string }>; formato: string; cliente: string };
  const mapped = await invoke("proveedor_mapear_campos", { caso, campos: data.campos }, ctx, calls); if (!mapped.ok) return { reply: `No pude mapear los campos: ${String(mapped.error)}`, needsConfirmation: false };
  const mapping = mapped.data as { llenos: unknown[]; faltantes: Array<{ etiqueta: string }>; requiere_confirmacion: Array<{ etiqueta: string; nota?: string }> };
  const form = await invoke("proveedor_generar_formulario", { caso, mapeo: mapping as never }, ctx, calls);
  const pack = await invoke("proveedor_armar_paquete", { caso }, ctx, calls);
  const packageData = pack.data as { listo_para_firma?: boolean; checklist?: Array<{ tipo: string; estado: string }> } | undefined;
  const blockers = packageData?.checklist?.filter((entry) => entry.estado !== "presente").map((entry) => `${entry.tipo} (${entry.estado})`) ?? [];
  const lines = [`Caso **${caso}** para ${data.cliente}.`, `Formulario: ${form.ok ? "generado" : `no generado (${String(form.error)})`}.`, `Campos llenos: ${mapping.llenos.length}. Faltantes: ${mapping.faltantes.length ? mapping.faltantes.map((field) => field.etiqueta).join(", ") : "ninguno"}.`, `Requieren confirmación: ${mapping.requiere_confirmacion.length ? mapping.requiere_confirmacion.map((field) => `${field.etiqueta}${field.nota ? ` (${field.nota})` : ""}`).join(", ") : "ninguno"}.`, `Paquete: ${packageData?.listo_para_firma ? "listo para firma" : `bloqueado por ${blockers.join(", ") || "revisión pendiente"}`}.`, "¿Deseas que simule el envío? No se enviará ningún correo real."];
  return { reply: lines.join("\n"), needsConfirmation: true };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    try { const provider = configuredProvider(); return send(res, 200, { ok: true, provider, model: provider === "openai" ? process.env.OPENAI_MODEL ?? "gpt-4.1-mini" : provider === "gemini" ? process.env.GEMINI_MODEL ?? "gemini-flash-latest" : "none" }); } catch (error) { return send(res, 500, { ok: false, error: error instanceof Error ? error.message : "Configuración inválida" }); }
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) return send(res, 200, sessions.get(decodeURIComponent(url.pathname.slice(14))) ?? { history: [] });
  if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await readFile(path.join(directory, "web", "index.html"))); return; }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    let payload: unknown; try { payload = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "Solicitud de chat inválida" }); }
    const parsed = chatSchema.safeParse(payload); if (!parsed.success) return send(res, 400, { error: "Solicitud de chat inválida" });
    const { sessionId, message } = parsed.data; const session = sessions.get(sessionId) ?? { history: [] }; const calls: ToolCall[] = []; const ctx = { directory, sessionId };
    let result: { reply: string; needsConfirmation: boolean };
    if (session.pendingSendCase && /^(si|sí|confirmo|confirmar|env[ií]a|enviar)\b/i.test(message.trim())) {
      const simulated = await invoke("proveedor_simular_envio", { caso: session.pendingSendCase, confirmado: true }, ctx, calls);
      result = { reply: simulated.ok ? `Envío simulado registrado para ${session.pendingSendCase}.` : `No pude simular el envío: ${String(simulated.error)}`, needsConfirmation: false };
      session.pendingSendCase = undefined;
      session.history.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
    } else if (/simular.*env[ií]o|env[ií]a|enviar/i.test(message) && !session.pendingSendCase) {
      result = { reply: "Antes de simular el envío necesito que proceses un caso y confirmes explícitamente la pregunta del turno anterior.", needsConfirmation: false };
      session.history.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
    } else {
      try {
        const provider = configuredProvider();
        const adapter = createAdapter(provider);
        if (adapter) {
          const agent = await runLlmAgent({ adapter, directory, history: session.history, message, maxIterations });
          const packagedCase = [...agent.toolCalls].reverse().find((call) => call.name === "proveedor_armar_paquete")?.arguments.caso;
          const casoParaConfirmar = typeof packagedCase === "string" ? packagedCase : undefined;
          const confirmationQuestion = "¿Deseas que simule el envío? No se enviará ningún correo real.";
          result = {
            reply: casoParaConfirmar && !agent.reply.includes(confirmationQuestion) ? `${agent.reply}\n\n${confirmationQuestion}` : agent.reply,
            needsConfirmation: Boolean(casoParaConfirmar)
          };
          if (casoParaConfirmar) session.pendingSendCase = casoParaConfirmar;
          calls.push(...agent.toolCalls);
          session.history = agent.history;
        } else {
          const caso = caseFrom(message);
          if (caso && /(procesa|procesar|caso|prepara|preparar)/i.test(message)) { result = await processCase(caso, ctx, calls); if (result.needsConfirmation) session.pendingSendCase = caso; }
          else result = { reply: "Indica “Procesa el caso \"co-industrias-delta\"” para iniciar. El modo local funciona sin clave de modelo.", needsConfirmation: false };
          session.history.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
        }
        } catch (error) {
          const caso = caseFrom(message);
          if (error instanceof ProviderUnavailableError && caso && /(procesa|procesar|caso|prepara|preparar)/i.test(message)) {
            result = await processCase(caso, ctx, calls);
            result.reply = `Gemini no está disponible temporalmente; procesé el caso con el flujo determinista.\n\n${result.reply}`;
            if (result.needsConfirmation) session.pendingSendCase = caso;
          } else {
            result = { reply: error instanceof Error ? error.message : "No fue posible procesar la solicitud.", needsConfirmation: false };
          }
          session.history.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
        }
    }
    session.history = session.history.slice(-maxMessages); sessions.set(sessionId, session); return send(res, 200, { ...result, toolCalls: calls });
  }
  send(res, 404, { error: "Ruta no encontrada" });
});
const port = Number(process.env.PORT ?? 3000); server.listen(port, () => console.log(`Registro de proveedor disponible en http://localhost:${port}`));
