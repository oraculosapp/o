import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamOracle,
  startOracleStream,
  mentionPaqoPublic,
  getStoredName,
  storeName,
  getStoredConversationId,
  storeConversationId,
  pickTint,
  mentionsPaqo,
} from "../oracle-client";

// --- Helpers -----------------------------------------------------------------
const enc = new TextEncoder();

/** Cuerpo SSE cerrado, con los eventos ya escritos. */
function sseBody(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

/**
 * Cuerpo SSE MUDO que se corta al abortar la señal, como hace un fetch real.
 * Devuelve además el controller para poder emitir datos a mano (rearme del
 * watchdog).
 */
function muteBody(signal: AbortSignal): {
  body: ReadableStream<Uint8Array>;
  push(event: Record<string, unknown>): void;
  close(): void;
} {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      signal.addEventListener("abort", () => {
        try {
          c.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          /* ya cerrado */
        }
      });
    },
  });
  return {
    body,
    push: (event) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)),
    close: () => ctl.close(),
  };
}

const params = {
  oracleId: "paqo",
  mode: "private" as const,
  biosphereId: "paqo",
  messages: [{ role: "user" as const, content: "hola" }],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "window");
});

// --- streamOracle ------------------------------------------------------------
describe("streamOracle", () => {
  it("emite onDone UNA SOLA VEZ aunque llegue el evento `done` y cierre el cuerpo", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse(
        sseBody([
          { type: "meta", conversationId: "c1", promptResolved: true },
          { type: "delta", text: "Hola" },
          { type: "delta", text: ", viajero" },
          { type: "done" },
        ])
      )
    ) as typeof fetch;

    const onDone = vi.fn();
    const onDelta = vi.fn();
    const onMeta = vi.fn();
    const onError = vi.fn();
    await streamOracle(params, { onDone, onDelta, onMeta, onError });

    // El bug: `done` (evento) + fin del reader disparaban DOS veces el callback.
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls.map((c) => c[0]).join("")).toBe("Hola, viajero");
    expect(onMeta).toHaveBeenCalledWith({ conversationId: "c1", promptResolved: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("el watchdog corta el stream si la red se queda muda (busy no se enclava)", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) =>
      sseResponse(muteBody(init.signal).body)
    ) as unknown as typeof fetch;

    const onError = vi.fn();
    const onDone = vi.fn();
    const done = streamOracle({ ...params, inactivityMs: 20_000 }, { onError, onDone });

    await vi.advanceTimersByTimeAsync(20_001);
    await done; // sin watchdog esta promesa no resolvía JAMÁS

    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("silencio");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("el watchdog se REARMA con cada dato (una respuesta larga no se corta)", async () => {
    vi.useFakeTimers();
    let wire!: ReturnType<typeof muteBody>;
    globalThis.fetch = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) => {
      wire = muteBody(init.signal);
      return sseResponse(wire.body);
    }) as unknown as typeof fetch;

    const onError = vi.fn();
    const onDone = vi.fn();
    const onDelta = vi.fn();
    const done = streamOracle({ ...params, inactivityMs: 20_000 }, { onError, onDelta, onDone });

    await vi.advanceTimersByTimeAsync(15_000); // 15 s < 20 s: aún vivo
    wire.push({ type: "delta", text: "voy" });
    await vi.advanceTimersByTimeAsync(1); // deja que el reader procese y rearme
    await vi.advanceTimersByTimeAsync(15_000); // otros 15 s desde el último dato
    wire.push({ type: "done" });
    wire.close();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDelta).toHaveBeenCalledWith("voy");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("abortar desde fuera termina en silencio (ni error ni done)", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) =>
      sseResponse(muteBody(init.signal).body)
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const onError = vi.fn();
    const onDone = vi.fn();
    const done = streamOracle({ ...params, signal: controller.signal }, { onError, onDone });
    controller.abort();
    await done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("startOracleStream expone la cancelación al caller (desmontaje)", async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) =>
      sseResponse(muteBody(init.signal).body)
    ) as unknown as typeof fetch;

    const onError = vi.fn();
    const onDone = vi.fn();
    const handle = startOracleStream(params, { onError, onDone });
    handle.cancel(); // lo que hace el cleanup del hook al desmontar el dock
    await handle.done;

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reporta el error del servidor sin lanzar (respuesta no-ok)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Demasiadas peticiones. Espera un momento." }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
    ) as typeof fetch;

    const onError = vi.fn();
    const onDone = vi.fn();
    await streamOracle(params, { onError, onDone });
    expect(onError).toHaveBeenCalledWith("Demasiadas peticiones. Espera un momento.");
    expect(onDone).not.toHaveBeenCalled();
  });
});

// --- mentionPaqoPublic -------------------------------------------------------
describe("mentionPaqoPublic", () => {
  const mention = { biosphereId: "paqo", messages: [{ role: "user" as const, content: "@paqo hola" }] };

  it("señala el COOLDOWN al caller en vez de tragárselo en silencio", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ skipped: "cooldown" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as typeof fetch;

    expect(await mentionPaqoPublic(mention)).toEqual({ ok: false, reason: "cooldown" });
  });

  it("señala el 429 (rate-limit)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Demasiadas peticiones." }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
    ) as typeof fetch;

    expect(await mentionPaqoPublic(mention)).toEqual({ ok: false, reason: "rate-limited" });
  });

  it("señala 503/5xx como no disponible", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "falta OPENAI_API_KEY" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
    ) as typeof fetch;

    expect(await mentionPaqoPublic(mention)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("señala la caída de red / el tope de espera", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await mentionPaqoPublic(mention)).toEqual({ ok: false, reason: "network" });
    warn.mockRestore();
  });

  it("drena el SSE con TOPE y lo CANCELA si no termina (nada de leer sin fin)", async () => {
    let cancelled = false;
    let emitted = 0;
    const infinite = new ReadableStream<Uint8Array>({
      pull(c) {
        emitted++;
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "delta", text: "x" })}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(async () => sseResponse(infinite)) as typeof fetch;

    // Antes esto era un `while(!(await reader.read()).done) {}` sin tope: con un
    // stream que no cierra, la promesa no volvía nunca.
    expect(await mentionPaqoPublic(mention)).toEqual({ ok: true });
    expect(cancelled).toBe(true);
    expect(emitted).toBeGreaterThan(0);
  });

  it("da ok cuando el SSE termina bien y pasa el speakerName al servidor", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(sseBody([{ type: "delta", text: "hola" }, { type: "done" }]))
    );
    globalThis.fetch = fetchMock as typeof fetch;

    expect(await mentionPaqoPublic({ ...mention, speakerName: "Lucía" })).toEqual({ ok: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ oracleId: "paqo", mode: "public", speakerName: "Lucía" });
    // Y siempre con tope de espera (AbortSignal.timeout).
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

// --- Helpers de identidad con almacenamiento BLOQUEADO ------------------------
/**
 * El caso de S14: incógnito / cookies de terceros bloqueadas → `localStorage`
 * LANZA al leer. Como `page.tsx` llama a estos helpers en el ámbito de módulo,
 * una excepción aquí dejaba la app EN BLANCO.
 */
describe("helpers de localStorage con el almacenamiento bloqueado", () => {
  function blockStorage(): void {
    const boom = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { localStorage: { getItem: boom, setItem: boom, removeItem: boom } },
    });
  }

  it("ninguno lanza: degradan en silencio", () => {
    blockStorage();
    expect(() => getStoredName()).not.toThrow();
    expect(() => storeName("Lucía")).not.toThrow();
    expect(() => getStoredConversationId("paqo")).not.toThrow();
    expect(() => storeConversationId("paqo", "c1")).not.toThrow();
    expect(() => pickTint("paqo")).not.toThrow();
  });

  it("devuelven valores utilizables (null / un tint válido)", () => {
    blockStorage();
    expect(getStoredName()).toBeNull();
    expect(getStoredConversationId("paqo")).toBeNull();
    // El tint se deriva de la semilla aunque no se pueda persistir, y es estable.
    const tint = pickTint("paqo");
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(pickTint("paqo")).toBe(tint);
  });

  it("sin window (SSR) tampoco lanzan", () => {
    expect(getStoredName()).toBeNull();
    expect(getStoredConversationId("paqo")).toBeNull();
    expect(() => storeName("Lucía")).not.toThrow();
    expect(pickTint("paqo")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("mentionsPaqo", () => {
  it("detecta la mención por @paqo o al abrir la frase", () => {
    expect(mentionsPaqo("oye @paqo ¿dónde estoy?")).toBe(true);
    expect(mentionsPaqo("Paqo, ayúdame")).toBe(true);
    expect(mentionsPaqo("hola a todos")).toBe(false);
  });
});
