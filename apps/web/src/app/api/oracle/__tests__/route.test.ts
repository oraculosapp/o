import { describe, it, expect } from "vitest";
import { createOracleRoute, type OracleRouteDeps } from "../../../../lib/oracle/handler";
import { ChatModelError, type ChatMessage, type ChatModel } from "../../../../lib/oracle/chat-model";
import { createRateLimiter } from "../../../../lib/oracle/rate-limit";

// --- Helpers -----------------------------------------------------------------
function makeReq(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/oracle", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** ChatModel stub que emite tokens fijos y registra los mensajes recibidos. */
function stubModel(tokens: string[], capture?: { messages?: ChatMessage[] }): ChatModel {
  return {
    async *streamChat(messages: ChatMessage[]) {
      if (capture) capture.messages = messages;
      for (const t of tokens) yield t;
    },
    async complete() {
      return "resumen";
    },
  };
}

/** ChatModel stub que falla al primer token. */
function failingModel(err: Error): ChatModel {
  return {
    // eslint-disable-next-line require-yield
    async *streamChat() {
      throw err;
    },
    async complete() {
      return "";
    },
  };
}

function baseDeps(over: Partial<OracleRouteDeps> = {}): OracleRouteDeps {
  return {
    getSystemPrompt: async () => ({ prompt: "SYSTEM_PAQO", resolved: true }),
    createChatModel: () => stubModel(["Hola", ", ", "viajero"]),
    getServiceClient: () => null,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    ...over,
  };
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data:\s*/, "").trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- Tests -------------------------------------------------------------------
const validBody = {
  oracleId: "paqo",
  mode: "public",
  messages: [{ role: "user", content: "¿a dónde voy?" }],
};

describe("POST /api/oracle", () => {
  it("hace streaming SSE con meta, deltas y done", async () => {
    const POST = createOracleRoute(baseDeps());
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    expect(events[0]).toMatchObject({ type: "meta", promptResolved: true });
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text);
    expect(deltas.join("")).toBe("Hola, viajero");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("NUNCA concatena el texto del usuario al system prompt", async () => {
    const capture: { messages?: ChatMessage[] } = {};
    const POST = createOracleRoute(
      baseDeps({ createChatModel: () => stubModel(["ok"], capture) })
    );
    await POST(makeReq(validBody)).then(readSse);
    const sys = capture.messages?.find((m) => m.role === "system");
    expect(sys?.content).toBe("SYSTEM_PAQO");
    expect(sys?.content).not.toContain("¿a dónde voy?");
    // El mensaje del usuario va como turno independiente.
    expect(capture.messages?.some((m) => m.role === "user" && m.content === "¿a dónde voy?")).toBe(
      true
    );
  });

  it("devuelve 400 con payload inválido", async () => {
    const POST = createOracleRoute(baseDeps());
    const res = await POST(makeReq({ oracleId: "paqo", mode: "public", messages: [] }));
    expect(res.status).toBe(400);
  });

  it("devuelve 400 con JSON malformado", async () => {
    const POST = createOracleRoute(baseDeps());
    const res = await POST(makeReq("{ no-json"));
    expect(res.status).toBe(400);
  });

  it("devuelve 503 si falta el modelo (sin OPENAI_API_KEY)", async () => {
    const POST = createOracleRoute(baseDeps({ createChatModel: () => null }));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(String(body.error)).toContain("OPENAI_API_KEY");
  });

  it("devuelve 429 al exceder el rate-limit", async () => {
    const POST = createOracleRoute(
      baseDeps({ rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) })
    );
    const first = await POST(makeReq(validBody));
    expect(first.status).toBe(200);
    await readSse(first); // drena
    const second = await POST(makeReq(validBody));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });

  it("propaga el status de ChatModelError si el modelo falla de inmediato", async () => {
    const POST = createOracleRoute(
      baseDeps({ createChatModel: () => failingModel(new ChatModelError("key mala", 401)) })
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
  });

  it("usa 502 para errores genéricos del modelo", async () => {
    const POST = createOracleRoute(
      baseDeps({ createChatModel: () => failingModel(new Error("boom")) })
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(502);
  });
});
