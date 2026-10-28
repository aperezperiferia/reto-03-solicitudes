import path from "node:path";
import { readdir } from "node:fs/promises";
import { armar_paquete, generar_formulario, leer_solicitud, limpiarSalida, mapear_campos } from "./src/tools/proveedor.js";

const directory = process.cwd();
await limpiarSalida(directory);
const cases = (await readdir(path.join(directory, "casos"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
for (const caso of cases) {
  const ctx = { directory, sessionId: "demo" };
  const solicitud = JSON.parse(await leer_solicitud.execute({ caso }, ctx));
  if (!solicitud.ok) { console.log(`${caso}: ERROR ${solicitud.error}`); continue; }
  const mapeo = JSON.parse(await mapear_campos.execute({ caso, campos: solicitud.data.campos }, ctx));
  const formulario = JSON.parse(await generar_formulario.execute({ caso, mapeo: mapeo.data }, ctx));
  const paquete = JSON.parse(await armar_paquete.execute({ caso }, ctx));
  console.log(JSON.stringify({ caso, formulario: formulario.ok ? formulario.data.ruta : formulario.error, llenos: mapeo.data.llenos.length, faltantes: mapeo.data.faltantes.length, confirmaciones: mapeo.data.requiere_confirmacion.length, listo_para_firma: paquete.ok && paquete.data.listo_para_firma }, null, 2));
}
