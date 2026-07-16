/**
 * POST /api/oracle — conversación con un Oráculo (GPT 5.4), respuesta en streaming.
 *
 * Contrato de petición (JSON):
 *   {
 *     oracleId: string,                 // p.ej. "paqo"
 *     mode: "public" | "private",
 *     messages: [{ role: "user"|"oracle", content: string }, ...],
 *     conversationId?: string,          // opcional, para continuar memoria privada
 *     biosphereId?: string,             // canal del chat público (mode "public")
 *     speakerName?: string              // opcional (mode "public"): nickname del
 *                                       //   hablante; Paqo lo usa para dirigirse
 *                                       //   a la persona por su nombre (saneado)
 *   }
 * Cabeceras opcionales:
 *   Authorization: Bearer <access_token>   // sesión Supabase (memoria en private)
 *   x-session-id: <id efímero de cliente>  // afina el rate-limit por sesión
 *
 * Respuesta: text/event-stream (SSE). Eventos `data: <json>`:
 *   { "type": "meta",  "conversationId"?: string, "promptResolved": boolean }
 *   { "type": "delta", "text": string }         // repetido
 *   { "type": "error", "message": string }       // sólo si falla a mitad
 *   { "type": "done" }
 *
 * Guardarraíles:
 *   · rate-limit en memoria por IP+sesión (best-effort serverless, ver rate-limit.ts),
 *   · 503 claro si falta OPENAI_API_KEY,
 *   · timeout 30s (en el ChatModel),
 *   · moderación de longitud y saneo anti-inyección: el mensaje del usuario JAMÁS
 *     se concatena al system prompt (ver validate.ts / buildChatMessages).
 *
 * La lógica vive en `lib/oracle/handler.ts` (fábrica inyectable + testeable);
 * este archivo sólo la cablea con las dependencias reales, porque un route file
 * de Next no admite exports adicionales.
 */
import { createOpenAiChatModel } from "../../../lib/oracle/chat-model";
import { getOracleSystemPrompt } from "../../../lib/oracle/prompts";
import { createRateLimiter } from "../../../lib/oracle/rate-limit";
import { createCooldown } from "../../../lib/oracle/cooldown";
import { getServiceClient } from "../../../lib/supabase-admin";
import { createOracleRoute, type OracleRouteDeps } from "../../../lib/oracle/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rate-limit PRIMARIO por IP fiable, singleton por instancia (ver limitación
// serverless en rate-limit.ts).
const rateLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

// Rate-limit SECUNDARIO por (IP + x-session-id): cap más estricto que sólo puede
// ENDURECER el límite por IP, nunca aflojarlo (ver handler.ts). 12 < 20.
const sessionLimiter = createRateLimiter({ limit: 12, windowMs: 60_000 });

// Cooldown del chat público: 1 respuesta de Paqo cada 10 s por canal de Biósfera.
const publicCooldown = createCooldown({ windowMs: 10_000 });

const deps: OracleRouteDeps = {
  getSystemPrompt: getOracleSystemPrompt,
  // El modelo se resuelve por entorno (`ORACLE_MODEL`) dentro de chat-model.ts.
  createChatModel: () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return createOpenAiChatModel({ apiKey });
  },
  getServiceClient,
  rateLimiter,
  sessionLimiter,
  publicCooldown,
};

export const POST = createOracleRoute(deps);
