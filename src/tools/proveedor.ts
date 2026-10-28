import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { z } from "zod";

export type ToolContext = { directory: string; sessionId: string };
type Json = Record<string, unknown>;
type Field = { etiqueta: string; obligatorio?: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string };
type Mapping = { etiqueta: string; clave?: string; valor?: unknown; nota?: string; confianza?: number; obligatorio?: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string };
type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

const text = (value: ToolResult<unknown>) => JSON.stringify(value);
const date = () => new Date().toISOString().slice(0, 10);
const root = (ctx: ToolContext) => path.resolve(ctx.directory);
const caseDir = (ctx: ToolContext, caso: string) => path.join(root(ctx), "casos", caso);
const outDir = (ctx: ToolContext, caso: string) => path.join(root(ctx), "out", caso);
const safeCase = (caso: string) => !caso.includes("/") && !caso.includes("\\") && /^[a-z0-9-]+$/i.test(caso);

async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
async function exists(file: string): Promise<boolean> { try { await readFile(file); return true; } catch { return false; } }
function getPath(value: Json, key: string): unknown { return key.split(".").reduce<unknown>((current, segment) => current && typeof current === "object" ? (current as Json)[segment] : undefined, value); }
function resultError(error: unknown): string { return error instanceof Error ? error.message : "Error inesperado"; }
function fieldsFromTemplate(template: Field[]): Field[] { return template.map((field) => ({ ...field, obligatorio: field.obligatorio ?? true })); }

async function log(ctx: ToolContext, caso: string, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  if (!safeCase(caso)) return;
  const folder = outDir(ctx, caso);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), herramienta, ok, resumen })}\n`, { flag: "a" });
}

async function loadCase(ctx: ToolContext, caso: string): Promise<{ solicitud: Json; fields: Field[]; soportes: string[] }> {
  if (!safeCase(caso)) throw new Error("Nombre de caso inválido");
  const folder = caseDir(ctx, caso);
  const solicitud = await json<Json>(path.join(folder, "solicitud.json"));
  const formato = solicitud.formato;
  const templateFile = formato === "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json";
  const fields = fieldsFromTemplate(await json<Field[]>(path.join(folder, templateFile)));
  const soportes = await json<string[]>(path.join(folder, "soportes-exigidos.json"));
  return { solicitud, fields, soportes };
}

async function map(ctx: ToolContext, caso: string, campos: Field[]): Promise<{ llenos: Mapping[]; faltantes: Mapping[]; requiere_confirmacion: Mapping[] }> {
  const maestro = await json<Json>(path.join(root(ctx), "repositorio", "maestro.json"));
  const glosario = await json<Record<string, string>>(path.join(root(ctx), "glosario-campos.json"));
  const { solicitud } = await loadCase(ctx, caso);
  const country = String(solicitud.pais);
  const taxLabels = new Set(["NIT", "RUC", "RTN", "Identificación tributaria", "Número de identificación fiscal"]);
  const output = { llenos: [] as Mapping[], faltantes: [] as Mapping[], requiere_confirmacion: [] as Mapping[] };
  for (const field of campos) {
    const base: Mapping = { ...field, clave: glosario[field.etiqueta], confianza: glosario[field.etiqueta] ? 1 : 0 };
    if (taxLabels.has(field.etiqueta) && country !== "CO") {
      const value = getPath(maestro, "nit");
      output.requiere_confirmacion.push({ ...base, valor: value, nota: "identificador extranjero", confianza: 0.7 });
      continue;
    }
    if (!base.clave) { output.faltantes.push({ ...base, nota: "No existe equivalencia en el glosario" }); continue; }
    const value = getPath(maestro, base.clave);
    if (value === undefined || value === null || value === "") output.faltantes.push({ ...base, nota: "No existe en el maestro" });
    else output.llenos.push({ ...base, valor: value });
  }
  return output;
}

export const leer_solicitud = {
  description: "Lee una solicitud y su plantilla para identificar formato, campos y soportes exigidos.",
  args: { caso: z.string().min(1).describe("Nombre de la carpeta del caso en casos/") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const loaded = await loadCase(ctx, args.caso);
      const data = { pais: loaded.solicitud.pais, cliente: loaded.solicitud.cliente, formato: loaded.solicitud.formato, campos: loaded.fields, soportes: loaded.soportes };
      await log(ctx, args.caso, "proveedor_leer_solicitud", true, `${loaded.fields.length} campos detectados`);
      return text({ ok: true, data });
    } catch (error) { await log(ctx, args.caso, "proveedor_leer_solicitud", false, resultError(error)); return text({ ok: false, error: resultError(error) }); }
  }
};

export const mapear_campos = {
  description: "Cruza los campos solicitados con maestro y glosario sin inventar valores.",
  args: { caso: z.string().min(1).describe("Nombre de la carpeta del caso"), campos: z.array(z.object({ etiqueta: z.string().describe("Etiqueta del campo"), obligatorio: z.boolean().optional(), hoja: z.string().optional(), celda_etiqueta: z.string().optional(), celda_valor: z.string().optional() })).describe("Campos obtenidos de la solicitud") },
  async execute(args: { caso: string; campos: Field[] }, ctx: ToolContext): Promise<string> {
    try {
      const data = await map(ctx, args.caso, args.campos);
      await log(ctx, args.caso, "proveedor_mapear_campos", true, `${data.llenos.length} llenos, ${data.faltantes.length} faltantes`);
      return text({ ok: true, data });
    } catch (error) { await log(ctx, args.caso, "proveedor_mapear_campos", false, resultError(error)); return text({ ok: false, error: resultError(error) }); }
  }
};

async function pdf(file: string, title: string, rows: Mapping[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const stream = createWriteStream(file);
    doc.pipe(stream); doc.fontSize(18).text(title); doc.moveDown();
    for (const row of rows) { doc.fontSize(10).fillColor("#1f2937").text(row.etiqueta); doc.fontSize(11).fillColor("#000000").text(String(row.valor ?? "PENDIENTE")); doc.moveDown(0.55); }
    doc.end(); stream.on("finish", resolve); stream.on("error", reject);
  });
}

export const generar_formulario = {
  description: "Genera el formulario XLSX, PDF o valores para portal usando exclusivamente un mapeo trazable.",
  args: { caso: z.string().min(1).describe("Nombre de la carpeta del caso"), mapeo: z.object({ llenos: z.array(z.record(z.unknown())).describe("Campos con datos verificados"), faltantes: z.array(z.record(z.unknown())).optional().describe("Campos sin dato"), requiere_confirmacion: z.array(z.record(z.unknown())).optional().describe("Campos que requieren validación") }).describe("Resultado de proveedor_mapear_campos") },
  async execute(args: { caso: string; mapeo: { llenos: Mapping[]; faltantes?: Mapping[]; requiere_confirmacion?: Mapping[] } }, ctx: ToolContext): Promise<string> {
    try {
      const { solicitud, fields } = await loadCase(ctx, args.caso); const folder = outDir(ctx, args.caso); await mkdir(folder, { recursive: true });
      const candidates = [...args.mapeo.llenos, ...(args.mapeo.requiere_confirmacion ?? [])];
      const values = new Map(candidates.map((row) => [row.etiqueta, row.valor])); let route: string;
      if (solicitud.formato === "xlsx") {
        const wb = XLSX.utils.book_new();
        for (const field of fields) { const sheet = wb.Sheets[field.hoja!] ?? XLSX.utils.aoa_to_sheet([]); sheet[field.celda_etiqueta!] = { t: "s", v: field.etiqueta }; const value = values.get(field.etiqueta); if (value !== undefined) sheet[field.celda_valor!] = { t: "s", v: String(value) }; if (!wb.SheetNames.includes(field.hoja!)) XLSX.utils.book_append_sheet(wb, sheet, field.hoja!); }
        route = path.join(folder, "formulario.xlsx"); XLSX.writeFile(wb, route);
      } else if (solicitud.formato === "pdf") { route = path.join(folder, "formulario.pdf"); await pdf(route, `Registro de proveedor — ${String(solicitud.cliente)}`, fields.map((field) => ({ ...field, valor: values.get(field.etiqueta) }))); }
      else if (solicitud.formato === "portal") { route = path.join(folder, "valores-portal.md"); const lines = ["# Valores para portal", "", ...fields.map((field) => `- **${field.etiqueta}:** ${String(values.get(field.etiqueta) ?? "PENDIENTE")}`), "", "El portal no se automatiza en este reto."]; await writeFile(route, lines.join("\n")); }
      else throw new Error(`Formato no soportado: ${String(solicitud.formato)}`);
      const data = { ruta: path.relative(root(ctx), route).replaceAll("\\", "/"), formato: solicitud.formato };
      await log(ctx, args.caso, "proveedor_generar_formulario", true, `Formulario ${data.formato} generado`); return text({ ok: true, data });
    } catch (error) { await log(ctx, args.caso, "proveedor_generar_formulario", false, resultError(error)); return text({ ok: false, error: resultError(error) }); }
  }
};

export const armar_paquete = {
  description: "Crea el paquete para firma con formulario, soportes, checklist y borrador de correo.",
  args: { caso: z.string().min(1).describe("Nombre de la carpeta del caso") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const { solicitud, soportes } = await loadCase(ctx, args.caso); const folder = outDir(ctx, args.caso); const pack = path.join(folder, "paquete"); await mkdir(pack, { recursive: true });
      const index = await json<Array<{ tipo: string; archivo: string; vigencia_hasta: string | null }>>(path.join(root(ctx), "repositorio", "soportes", "index.json"));
      const entries = await Promise.all(soportes.map(async (tipo) => { const support = index.find((item) => item.tipo === tipo); if (!support) return { tipo, estado: "ausente" }; const expired = Boolean(support.vigencia_hasta && support.vigencia_hasta < date()); if (!expired) await copyFile(path.join(root(ctx), "repositorio", "soportes", support.archivo), path.join(pack, support.archivo)); return { tipo, archivo: support.archivo, estado: expired ? "vencido" : "presente", vigencia_hasta: support.vigencia_hasta }; }));
      const form = solicitud.formato === "xlsx" ? "formulario.xlsx" : solicitud.formato === "pdf" ? "formulario.pdf" : "valores-portal.md";
      if (await exists(path.join(folder, form))) await copyFile(path.join(folder, form), path.join(pack, form));
      const blocking = entries.some((item) => item.estado !== "presente");
      const checklist = ["# Checklist de paquete", "", ...entries.map((item) => `- ${item.tipo}: **${item.estado}**${"vigencia_hasta" in item && item.vigencia_hasta ? ` (${item.vigencia_hasta})` : ""}`), "", `Estado: **${blocking ? "bloqueado" : "listo_para_firma"}**.`].join("\n");
      await writeFile(path.join(pack, "checklist.md"), checklist); await writeFile(path.join(pack, "borrador-correo.md"), `Asunto: Registro como proveedor — ${String(solicitud.cliente)}\n\nHola,\n\nAdjuntamos el formulario y los soportes disponibles para el proceso de registro como proveedor. Quedamos atentos a sus comentarios.\n\nSaludos,\nPeriferia IT Group\n`);
      const data = { ruta: path.relative(root(ctx), pack).replaceAll("\\", "/"), listo_para_firma: !blocking, checklist: entries };
      await log(ctx, args.caso, "proveedor_armar_paquete", true, data.listo_para_firma ? "Paquete listo para firma" : "Paquete bloqueado por soportes"); return text({ ok: true, data });
    } catch (error) { await log(ctx, args.caso, "proveedor_armar_paquete", false, resultError(error)); return text({ ok: false, error: resultError(error) }); }
  }
};

export const simular_envio = {
  description: "Registra un envío simulado únicamente con confirmación humana explícita.",
  args: { caso: z.string().min(1).describe("Nombre de la carpeta del caso"), confirmado: z.boolean().describe("Confirmación explícita de la persona en el turno anterior") },
  async execute(args: { caso: string; confirmado: boolean }, ctx: ToolContext): Promise<string> {
    try { if (!args.confirmado) return text({ ok: false, error: "requiere confirmación explícita" }); const route = path.join(outDir(ctx, args.caso), "ENVIO-SIMULADO.md"); await mkdir(path.dirname(route), { recursive: true }); await writeFile(route, `# Envío simulado\n\nCaso: ${args.caso}\nFecha: ${new Date().toISOString()}\nNo se envió ningún correo real.\n`); await log(ctx, args.caso, "proveedor_simular_envio", true, "Envío simulado registrado"); return text({ ok: true, data: { ruta: path.relative(root(ctx), route).replaceAll("\\", "/") } }); } catch (error) { return text({ ok: false, error: resultError(error) }); }
  }
};

export const proveedorTools = { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio };
export async function limpiarSalida(directory: string): Promise<void> { await rm(path.join(directory, "out"), { recursive: true, force: true }); }
