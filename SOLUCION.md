# Solución

## Problema
Automatiza para la analista administrativa la preparación trazable de registros de proveedor sin reemplazar firma, envío ni validación humana.

## Arquitectura

```text
Chat web -> API HTTP -> proveedor determinista o ciclo LLM -> herramientas Zod -> casos + repositorio
                                      |                         -> out/ (formularios, paquetes y auditoría)
                                      +-> OpenAI Responses API | Gemini @google/genai (opcionales)
```

El prompt operativo se carga desde `agent/prompt.md`. El ciclo LLM conserva contexto de sesión, declara las herramientas con JSON Schema derivado de Zod, valida los argumentos antes de ejecutarlas, devuelve cada resultado al modelo y se detiene en `MAX_AGENT_ITERATIONS`. La selección es `LLM_PROVIDER=deterministic|openai|gemini`.

## Seguridad y control humano

Las claves solo se obtienen de `OPENAI_API_KEY` o `GEMINI_API_KEY` en el backend; no se envían a cliente, logs ni respuestas HTTP. `demo.ts` usa directamente las herramientas y no instancia un modelo. Las herramientas consultan datos locales y mantienen la trazabilidad en `out/<caso>/log.jsonl`.

`proveedor_simular_envio` no es ejecutable por el ciclo LLM. El servidor la habilita exclusivamente cuando la persona confirma de forma explícita en el mensaje posterior a la pregunta. Solo escribe `ENVIO-SIMULADO.md`; no hay correo real.

## Proveedores

- **Determinista:** predeterminado, sin clave y reproducible.
- **OpenAI:** SDK `openai`, Responses API y `function_call` / `function_call_output` en el historial.
- **Gemini:** SDK `@google/genai`, `functionDeclarations` y resultados de herramientas como contexto para la siguiente generación.

Los límites de iteración y de historial contienen el costo y la ejecución. El adaptador no registra solicitudes, respuestas ni secretos.

## Trade-offs

1. Se preserva el flujo determinista para demos y continuidad sin proveedor externo.
2. Las herramientas son la fuente de verdad; el modelo no recibe permisos para enviar ni inventar valores.
3. Las sesiones permanecen en memoria por alcance local; producción requeriría autenticación, almacenamiento seguro, auditoría central, vault y colas.
4. XLSX usa SheetJS y PDF usa PDFKit para mantener ejecución reproducible en Node 20.

## Cobertura

| Historia | Estado | Alcance |
|---|---|---|
| HU-1 | Hecho | Lectura de solicitud, plantilla y soportes. |
| HU-2 | Hecho | Mapeo trazable, faltantes y regla tributaria. |
| HU-3 | Hecho | Formularios XLSX/PDF y valores para portal. |
| HU-4 | Hecho | Paquete, checklist, vigencias y envío simulado confirmado. |
| HU-5 | Hecho | Contratos Zod, ciclo de herramientas y LLM opcional. |

## Dependencias

`zod` valida contratos, `openai` integra Responses API, `@google/genai` integra Gemini, `dotenv` carga variables locales, `xlsx` escribe libros y `pdfkit` genera PDF.
