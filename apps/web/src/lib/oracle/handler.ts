/**
 * Fábrica del handler POST del Oráculo (separada de la ruta para poder testearla
 * e inyectar dependencias). La ruta `app/api/oracle/route.ts` sólo la instancia
 * con las dependencias reales — Next no permite exports extra en un route file.
 *
 * Ver el contrato de API completo en `app/api/oracle/route.ts`.
 *
 * MODO PÚBLICO (chat de Biósfera): cuando una persona menciona a Paqo en el chat
 * abierto, el cliente inserta su propio mensaje en `biosphere_messages` y ADEMÁS
 * llama a esta ruta con `mode: "public"`. Aquí generamos la respuesta y, al
 * terminar el stream, la INSERTAMOS en `biosphere_messages` con `is_oracle=true`
 * usando el cliente service-role (omite RLS). Así TODO el canal la recibe por
 * Realtime y el solicitante NO la renderiza dos veces. Un cooldown por canal
 * evita que una ráfaga de menciones inunde el chat.
 */
import { ChatModelError, type ChatModel } from "./chat-model";
import { validateOracleRequest, buildChatMessages, type OracleRequest } from "./validate";
import type { RateLimiter } from "./rate-limit";
import type { Cooldown } from "./cooldown";
import { resolveRegisteredUserId, ensureConversation, persistPrivateTurn } from "./persistence";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface OracleRouteDeps {
  getSystemPrompt: (oracleId: string) => Promise<{ prompt: string; resolved: boolean }>;
  /** Devuelve el modelo, o null si falta OPENAI_API_KEY. */
  createChatModel: () => ChatModel | null;
  /** Cliente service-role, o null si faltan sus env vars. */
  getServiceClient: () => SupabaseClient | null;
  rateLimiter: RateLimiter;
  /**
   * Cooldown del chat público por canal (1 respuesta cada N s). Opcional: si no
   * se inyecta, no se aplica cooldown (útil en tests). En producción la ruta
   * inyecta uno de 10 s.
   */
  publicCooldown?: Cooldown;
  /**
   * Nombre a mostrar del Oráculo al publicar en el chat público (columna
   * `display_name`, NOT NULL). Default: capitaliza el `oracleId`.
   */
  getOracleName?: (oracleId: string) => string;
}

/** Longitud máx. de `biosphere_messages.content` (CHECK en la migración). */
const PUBLIC_MESSAGE_MAX = 280;
/** Tokens acotados para las respuestas públicas: deben caber en ~280 chars. */
const PUBLIC_MAX_TOKENS = 140;
const PRIVATE_MAX_TOKENS = 400;

const encoder = new TextEncoder();

function sse(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function json(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip"))?.trim() || "unknown-ip";
  const session = req.headers.get("x-session-id")?.trim() || "no-session";
  return `${ip}::${session}`;
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

function defaultOracleName(oracleId: string): string {
  return oracleId
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Recorta la respuesta pública al límite de la columna, sin cortar a mitad de
 *  palabra cuando es posible (respeta el CHECK char_length <= 280). */
function clampPublic(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PUBLIC_MESSAGE_MAX) return trimmed;
  const slice = trimmed.slice(0, PUBLIC_MESSAGE_MAX - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > PUBLIC_MESSAGE_MAX * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

async function loadSummary(service: SupabaseClient, conversationId: string): Promise<string | null> {
  try {
    const { data } = await service
      .from("oracle_conversations")
      .select("summary")
      .eq("id", conversationId)
      .maybeSingle();
    return (data?.summary as string | null) ?? null;
  } catch {
    return null;
  }
}

/** Publica la respuesta del Oráculo en el chat público (is_oracle = true). */
async function publishPublicAnswer(
  service: SupabaseClient,
  params: { biosphereId: string; displayName: string; content: string }
): Promise<void> {
  const content = clampPublic(params.content);
  if (content.length === 0) return;
  try {
    await service.from("biosphere_messages").insert({
      biosphere_id: params.biosphereId,
      user_id: null,
      display_name: params.displayName,
      content,
      is_oracle: true,
    });
  } catch {
    /* best-effort: no romper el turno aunque falle la inserción */
  }
}

export function createOracleRoute(deps: OracleRouteDeps) {
  return async function POST(req: Request): Promise<Response> {
    // 1) Rate-limit -----------------------------------------------------------
    const rl = deps.rateLimiter.check(clientKey(req));
    if (!rl.allowed) {
      return json(
        429,
        { error: "Demasiadas peticiones. Espera un momento.", retryAfter: rl.retryAfter },
        { "retry-after": String(rl.retryAfter) }
      );
    }

    // 2) Parseo + validación --------------------------------------------------
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "JSON inválido." });
    }
    const validated = validateOracleRequest(body);
    if (!validated.ok) {
      return json(400, { error: validated.error });
    }
    const request: OracleRequest = validated.value;
    const isPublic = request.mode === "public";
    const channelId = request.biosphereId ?? request.oracleId;

    // 3) Modelo (503 si falta la key) ----------------------------------------
    const chatModel = deps.createChatModel();
    if (!chatModel) {
      return json(503, {
        error:
          "El Oráculo no está disponible: falta OPENAI_API_KEY en el servidor. " +
          "Configúrala en Vercel / .env.local (ver docs/s3-plataforma.md).",
      });
    }

    // 3b) Cooldown del chat público por canal --------------------------------
    // Se comprueba tras confirmar el modelo (no consumir el turno en balde) y
    // ANTES de generar (ahorra la llamada a OpenAI si estamos en cooldown).
    if (isPublic && deps.publicCooldown && !deps.publicCooldown.tryAcquire(channelId)) {
      return json(200, { skipped: "cooldown" });
    }

    // 4) System prompt + memoria (private + usuario registrado) --------------
    const { prompt: systemPrompt, resolved } = await deps.getSystemPrompt(request.oracleId);

    let conversationId: string | undefined;
    let service: SupabaseClient | null = null;
    let registeredUserId: string | null = null;
    const systemParts = [systemPrompt];

    if (request.mode === "private") {
      service = deps.getServiceClient();
      if (service) {
        registeredUserId = await resolveRegisteredUserId(service, bearer(req));
        if (registeredUserId) {
          conversationId =
            (await ensureConversation(service, {
              userId: registeredUserId,
              oracleId: request.oracleId,
              conversationId: request.conversationId,
            })) ?? undefined;
          if (conversationId) {
            const summary = await loadSummary(service, conversationId);
            if (summary) {
              systemParts.push(`Memoria de esta persona (resumen): ${summary}`);
            }
          }
        }
      }
    } else if (isPublic) {
      // En público sólo necesitamos el service-client para publicar la respuesta.
      service = deps.getServiceClient();
    }

    const chatMessages = buildChatMessages(systemParts.join("\n\n"), request.messages);
    const lastUserContent = request.messages[request.messages.length - 1].content;

    // 5) Streaming ------------------------------------------------------------
    const iterator = chatModel
      .streamChat(chatMessages, {
        maxTokens: isPublic ? PUBLIC_MAX_TOKENS : PRIVATE_MAX_TOKENS,
        temperature: 0.7,
      })
      [Symbol.asyncIterator]();

    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      const status = err instanceof ChatModelError && err.status ? err.status : 502;
      return json(status, { error: err instanceof Error ? err.message : "Fallo del modelo." });
    }

    const shouldPersist =
      request.mode === "private" && !!service && !!registeredUserId && !!conversationId;
    const shouldPublish = isPublic && !!service;
    const oracleName = (deps.getOracleName ?? defaultOracleName)(request.oracleId);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let full = "";
        controller.enqueue(sse({ type: "meta", conversationId, promptResolved: resolved }));
        try {
          if (!first.done && first.value) {
            full += first.value;
            controller.enqueue(sse({ type: "delta", text: first.value }));
          }
          let next = await iterator.next();
          while (!next.done) {
            full += next.value;
            controller.enqueue(sse({ type: "delta", text: next.value }));
            next = await iterator.next();
          }
        } catch (err) {
          controller.enqueue(
            sse({ type: "error", message: err instanceof Error ? err.message : "Error de streaming." })
          );
        }

        if (shouldPersist && full.trim().length > 0) {
          try {
            await persistPrivateTurn(service as SupabaseClient, chatModel, {
              conversationId: conversationId as string,
              userContent: lastUserContent,
              oracleContent: full,
            });
          } catch {
            /* doble seguro */
          }
        }

        if (shouldPublish && full.trim().length > 0) {
          await publishPublicAnswer(service as SupabaseClient, {
            biosphereId: channelId,
            displayName: oracleName,
            content: full,
          });
        }

        controller.enqueue(sse({ type: "done" }));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  };
}
