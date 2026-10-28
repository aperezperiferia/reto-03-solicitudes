# Agente de registro como proveedor

Aplicación TypeScript/Node 20 para preparar formularios, soportes y paquetes de firma desde casos locales.

## Ejecución

```bash
npm install
npm run demo
npm run dev
```

Abre `http://localhost:3000`. Sin clave, `LLM_PROVIDER=deterministic` procesa de forma reproducible: `Procesa el caso "ec-corp-andina". No envíes nada todavía.`

## LLM opcional

Copia `.env.example` a `.env`. El servidor selecciona exclusivamente uno de estos proveedores:

- `LLM_PROVIDER=deterministic`: sin modelo ni clave; es el predeterminado y el usado por `npm run demo`.
- `LLM_PROVIDER=openai`: requiere `OPENAI_API_KEY`; usa OpenAI Responses API y function calling.
- `LLM_PROVIDER=gemini`: requiere `GEMINI_API_KEY`; usa `@google/genai` y function declarations.

`OPENAI_MODEL` y `GEMINI_MODEL` permiten cambiar el modelo. Las claves se leen solo en backend, no se registran ni se devuelven en API/frontend. Las herramientas validan sus argumentos con Zod, cada resultado vuelve al modelo y `MAX_AGENT_ITERATIONS` limita el ciclo.

La simulación de envío siempre exige confirmación humana explícita en el turno posterior; incluso un LLM no puede invocar esa herramienta directamente.

## API

- `POST /api/chat` con `{ "sessionId": "id", "message": "..." }`
- `GET /api/sessions/:id`
- `GET /api/health`

## Validación

```bash
npm run typecheck
npm test
npm run demo
```

Las entradas en `casos/` y `repositorio/` son solo lectura. Los artefactos se generan en `out/`.
