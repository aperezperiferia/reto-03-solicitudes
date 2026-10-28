import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { armar_paquete, generar_formulario, leer_solicitud, limpiarSalida, mapear_campos, simular_envio } from "../src/tools/proveedor.js";
import { providerTools, runLlmAgent } from "../src/agent.js";
import type { LlmAdapter } from "../src/llm/adapter.js";

const directory = process.cwd();
const ctx = { directory, sessionId: "test" };

test("genera XLSX y bloquea paquete con soporte vencido", async () => {
  await limpiarSalida(directory);
  const read = JSON.parse(await leer_solicitud.execute({ caso: "co-industrias-delta" }, ctx));
  assert.equal(read.ok, true);
  const mapped = JSON.parse(await mapear_campos.execute({ caso: "co-industrias-delta", campos: read.data.campos }, ctx));
  assert.equal(mapped.data.llenos.length, 17);
  const form = JSON.parse(await generar_formulario.execute({ caso: "co-industrias-delta", mapeo: mapped.data }, ctx));
  assert.equal(form.data.formato, "xlsx");
  await access(path.join(directory, form.data.ruta));
  const pack = JSON.parse(await armar_paquete.execute({ caso: "co-industrias-delta" }, ctx));
  assert.equal(pack.data.listo_para_firma, false);
});

test("marca RUC extranjero para confirmación y no simula envío sin confirmación", async () => {
  const read = JSON.parse(await leer_solicitud.execute({ caso: "ec-corp-andina" }, ctx));
  const mapped = JSON.parse(await mapear_campos.execute({ caso: "ec-corp-andina", campos: read.data.campos }, ctx));
  assert.equal(mapped.data.requiere_confirmacion[0].nota, "identificador extranjero");
  const noSend = JSON.parse(await simular_envio.execute({ caso: "ec-corp-andina", confirmado: false }, ctx));
  assert.equal(noSend.ok, false);
});

test("el agente valida argumentos y bloquea la simulación de envío solicitada por el modelo", async () => {
  const adapter: LlmAdapter = { enviar: async () => ({ content: "", toolCalls: [{ id: "1", name: "proveedor_simular_envio", arguments: "{\"caso\":\"co-industrias-delta\",\"confirmado\":true}" }] }) };
  const result = await runLlmAgent({ adapter, directory, history: [], message: "envía", maxIterations: 1 });
  assert.match(result.reply, /máximo de iteraciones/);
  assert.equal(result.toolCalls.length, 0);
  assert.ok(providerTools().every((tool) => tool.schema.type === "object"));
});

test("el ciclo conserva las llamadas de función hasta recibir la respuesta final", async () => {
  let invocation = 0;
  const adapter: LlmAdapter = {
    enviar: async (_prompt, messages) => {
      invocation += 1;
      if (invocation === 1) return { content: "", toolCalls: [{ id: "call-1", name: "proveedor_leer_solicitud", arguments: "{\"caso\":\"ec-corp-andina\"}" }] };
      const assistant = messages.find((message) => message.role === "assistant");
      const tool = messages.find((message) => message.role === "tool");
      assert.equal(assistant?.functionCalls?.[0]?.name, "proveedor_leer_solicitud");
      assert.equal(tool?.toolCallId, "call-1");
      return { content: "Resumen final preparado.", toolCalls: [] };
    }
  };
  const result = await runLlmAgent({ adapter, directory, history: [], message: "procesa", maxIterations: 3 });
  assert.equal(result.reply, "Resumen final preparado.");
  assert.equal(result.toolCalls.length, 1);
});
