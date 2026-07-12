/**
 * Contrato de modelo de chat + implementación OpenAI (GPT 5.4).
 *
 * El `ChatModel` es INYECTABLE: la ruta recibe una instancia, y los tests pasan
 * un stub (sin red). La implementación real llama a la API de OpenAI vía fetch.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatModel {
  /** Streaming de tokens de texto (deltas ya decodificados). */
  streamChat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string>;
  /** Completar de una sola vez (para el resumen rodante). */
  complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export interface OpenAiChatModelConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Timeout duro por petición (ms). Default 30s. */
  timeoutMs?: number;
  /** fetch inyectable (tests). Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TEMPERATURE = 0.7;

/** Error tipado para que la ruta distinga fallos del modelo. */
export class ChatModelError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ChatModelError";
  }
}

function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Implementación OpenAI (Chat Completions con stream SSE).
 */
export function createOpenAiChatModel(config: OpenAiChatModelConfig): ChatModel {
  const {
    apiKey,
    // El modelo se parametriza por entorno: `ORACLE_MODEL` es la fuente canónica
    // (default "gpt-5.4"); `OPENAI_MODEL` se conserva como alias heredado. Un
    // `config.model` explícito (p.ej. desde un test) siempre gana.
    model = process.env.ORACLE_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = config;

  if (!apiKey) throw new ChatModelError("OPENAI_API_KEY ausente", 503);

  async function request(
    messages: ChatMessage[],
    opts: ChatOptions | undefined,
    stream: boolean
  ): Promise<Response> {
    const { signal, done } = withTimeout(timeoutMs, opts?.signal);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream,
          // OpenAI retiró max_tokens en los modelos gpt-5.x actuales
          max_completion_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
          messages,
        }),
        signal,
      });
    } catch (err) {
      done();
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatModelError(`Fallo de red hacia OpenAI: ${reason}`);
    }
    if (!res.ok) {
      done();
      const body = await res.text().catch(() => "");
      throw new ChatModelError(
        `OpenAI respondió ${res.status}: ${body.slice(0, 300)}`,
        res.status
      );
    }
    // El caller cierra el timer al terminar de consumir el body.
    (res as Response & { __done?: () => void }).__done = done;
    return res;
  }

  async function* streamChat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    const res = await request(messages, opts, true);
    const done = (res as Response & { __done?: () => void }).__done;
    if (!res.body) {
      done?.();
      throw new ChatModelError("OpenAI no devolvió cuerpo de streaming");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data);
            const delta: string | undefined = json?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // fragmento SSE incompleto: se ignora, el buffer lo recompone
          }
        }
      }
    } finally {
      done?.();
      reader.releaseLock?.();
    }
  }

  async function complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const res = await request(messages, opts, false);
    const done = (res as Response & { __done?: () => void }).__done;
    try {
      const json = await res.json();
      return json?.choices?.[0]?.message?.content ?? "";
    } finally {
      done?.();
    }
  }

  return { streamChat, complete };
}
