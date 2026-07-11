/**
 * Fábrica del handler POST del Oráculo (separada de la ruta para poder testearla
 * e inyectar dependencias). La ruta `app/api/oracle/route.ts` sólo la instancia
 * con las dependencias reales — Next no permite exports extra en un route file.
 *
 * Ver el contrato de API completo en `app/api/oracle/route.ts`.
 */
import { ChatModelError, type ChatModel } from "./chat-model";
import { validateOracleRequest, buildChatMessages, type OracleRequest } from "./validate";
import type { RateLimiter } from "./rate-limit";
import { resolveRegisteredUserId, ensureConversation, persistPrivateTurn } from "./persistence";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface OracleRouteDeps {
  getSystemPrompt: (oracleId: string) => Promise<{ prompt: string; resolved: boolean }>;
  /** Devuelve el modelo, o null si falta OPENAI_API_KEY. */
  createChatModel: () => ChatModel | null;
  /** Cliente service-role, o null si faltan sus env vars. */
  getServiceClient: () => SupabaseClient | null;
  rateLimiter: RateLimiter;
}

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

    // 3) Modelo (503 si falta la key) ----------------------------------------
    const chatModel = deps.createChatModel();
    if (!chatModel) {
      return json(503, {
        error:
          "El Oráculo no está disponible: falta OPENAI_API_KEY en el servidor. " +
          "Configúrala en Vercel / .env.local (ver docs/s3-plataforma.md).",
      });
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
    }

    const chatMessages = buildChatMessages(systemParts.join("\n\n"), request.messages);
    const lastUserContent = request.messages[request.messages.length - 1].content;

    // 5) Streaming ------------------------------------------------------------
    const iterator = chatModel
      .streamChat(chatMessages, { maxTokens: 400, temperature: 0.7 })
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
