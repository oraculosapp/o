/**
 * Cliente de navegador para /api/oracle (SSE) y utilidades del chat de Paqo.
 *
 * - `streamOracle`: consume el text/event-stream token a token (canal privado).
 * - `mentionPaqoPublic`: dispara una respuesta pública (mención en el chat
 *   abierto); NO renderiza nada — la respuesta llega a todos por Realtime cuando
 *   el servidor la inserta en `biosphere_messages`. Fire-and-forget con manejo
 *   de errores digno.
 * - Helpers de identidad (nombre/tint) persistida y de progreso al "encontrar".
 */
import { getSupabaseBrowserClient } from "./supabase";

export interface WireMessage {
  role: "user" | "oracle";
  content: string;
}

export interface OracleStreamCallbacks {
  onMeta?(meta: { conversationId?: string; promptResolved?: boolean }): void;
  onDelta?(text: string): void;
  onError?(message: string): void;
  onDone?(): void;
}

export interface OracleStreamParams {
  oracleId: string;
  mode: "public" | "private";
  biosphereId?: string;
  messages: WireMessage[];
  conversationId?: string;
  accessToken?: string | null;
  sessionId?: string;
  signal?: AbortSignal;
  /**
   * Silencio máximo tolerado (ms) entre datos del SSE antes de dar la conexión
   * por colgada. Sólo se toca en tests; por defecto `STREAM_INACTIVITY_MS`.
   */
  inactivityMs?: number;
}

/**
 * Watchdog de INACTIVIDAD del stream. No es un timeout total (una respuesta larga
 * puede tardar): se reinicia con CADA lectura de datos. Si la red se cuelga a
 * mitad —el caso que dejaba `busy` enclavado para siempre y el input muerto— se
 * aborta el fetch y se avisa con un error amable.
 */
export const STREAM_INACTIVITY_MS = 20_000;

const STALLED_MESSAGE =
  "El Oráculo se quedó en silencio (la conexión se colgó). Inténtalo de nuevo.";

/** Mando de un stream en curso: promesa de fin + cancelación para el caller. */
export interface OracleStreamHandle {
  /** Resuelve cuando el stream termina, falla o se cancela. Nunca lanza. */
  done: Promise<void>;
  /** Corta el stream en vuelo (desmontaje, cambio de vista, cancelar…). */
  cancel(): void;
}

/**
 * Igual que `streamOracle` pero devolviendo el mando de cancelación, para que el
 * caller (React) pueda cortar el SSE al desmontar sin fabricar su propio
 * AbortController. Encadena además la señal externa si ya venía una.
 */
export function startOracleStream(
  params: OracleStreamParams,
  cb: OracleStreamCallbacks
): OracleStreamHandle {
  const controller = new AbortController();
  const external = params.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return {
    done: streamOracle({ ...params, signal: controller.signal }, cb),
    cancel: () => controller.abort(),
  };
}

/** Detecta si un mensaje del chat abierto invoca a Paqo. */
export function mentionsPaqo(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.includes("@paqo") || /^paqo\b/.test(t);
}

function headersFor(params: OracleStreamParams): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (params.accessToken) headers.authorization = `Bearer ${params.accessToken}`;
  if (params.sessionId) headers["x-session-id"] = params.sessionId;
  return headers;
}

function bodyFor(params: OracleStreamParams): string {
  return JSON.stringify({
    oracleId: params.oracleId,
    mode: params.mode,
    biosphereId: params.biosphereId,
    messages: params.messages,
    conversationId: params.conversationId,
  });
}

/**
 * Consume el SSE de /api/oracle. Resuelve cuando termina el stream (o falla).
 * Nunca lanza por errores de red/servidor: los reporta vía `onError`.
 *
 * Dos garantías que el caller necesita para no quedarse colgado:
 *  · WATCHDOG de inactividad (`inactivityMs`, reiniciado en cada lectura): si la
 *    red se queda muda, aborta y avisa en vez de dejar la promesa viva.
 *  · `onDone` se emite UNA SOLA VEZ, aunque llegue el evento `done` y además el
 *    reader termine (antes se llamaba dos veces).
 */
export async function streamOracle(
  params: OracleStreamParams,
  cb: OracleStreamCallbacks
): Promise<void> {
  const inactivityMs = params.inactivityMs ?? STREAM_INACTIVITY_MS;

  // Controlador PROPIO: lo dispara el watchdog. La señal del caller se encadena,
  // así abortar desde fuera sigue funcionando igual.
  const controller = new AbortController();
  const external = params.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, inactivityMs);
  };

  // `done` una sola vez: el servidor manda el evento `done` Y ADEMÁS cierra el
  // cuerpo, y antes ambas cosas disparaban el callback.
  let finished = false;
  const emitDone = () => {
    if (finished) return;
    finished = true;
    cb.onDone?.();
  };

  try {
    let res: Response;
    arm();
    try {
      res = await fetch("/api/oracle", {
        method: "POST",
        headers: headersFor(params),
        body: bodyFor(params),
        signal: controller.signal,
      });
    } catch (err) {
      if (stalled) {
        cb.onError?.(STALLED_MESSAGE);
        return;
      }
      if ((err as Error)?.name === "AbortError") return;
      cb.onError?.("No se pudo contactar al Oráculo. Revisa tu conexión.");
      return;
    } finally {
      disarm();
    }

    if (!res.ok || !res.body) {
      let message = `El Oráculo respondió ${res.status}.`;
      try {
        const data = await res.json();
        if (data?.error) message = String(data.error);
      } catch {
        /* respuesta sin JSON */
      }
      cb.onError?.(message);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        // El watchdog vigila CADA espera de datos: se rearma en cada vuelta.
        arm();
        const { done, value } = await reader.read();
        disarm();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt: { type?: string; text?: string; message?: string; conversationId?: string; promptResolved?: boolean };
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }
          switch (evt.type) {
            case "meta":
              cb.onMeta?.({ conversationId: evt.conversationId, promptResolved: evt.promptResolved });
              break;
            case "delta":
              if (evt.text) cb.onDelta?.(evt.text);
              break;
            case "error":
              cb.onError?.(evt.message ?? "Error del Oráculo.");
              break;
            case "done":
              emitDone();
              break;
          }
        }
      }
      emitDone();
    } catch (err) {
      if (stalled) {
        cb.onError?.(STALLED_MESSAGE);
        return;
      }
      if ((err as Error)?.name === "AbortError") return;
      cb.onError?.("Se interrumpió la respuesta del Oráculo.");
    } finally {
      reader.releaseLock?.();
    }
  } finally {
    disarm();
    external?.removeEventListener("abort", onExternalAbort);
  }
}

/** Tope de espera de la mención pública (el modelo corta a 30 s server-side). */
const MENTION_TIMEOUT_MS = 30_000;
/** Tope de chunks al drenar el SSE público: nunca leemos sin fin. */
const MENTION_MAX_CHUNKS = 512;

/**
 * Resultado de una mención pública. `ok:false` NO es un fallo grave (la mención
 * del viajero ya está publicada), pero permite que la UI avise de por qué Paqo
 * no contestó.
 *  · "cooldown"     → 200 {skipped:"cooldown"}: otro viajero acaba de invocarlo.
 *  · "rate-limited" → 429: demasiadas peticiones.
 *  · "unavailable"  → 4xx/5xx (503 sin API key, 502 del modelo…).
 *  · "network"      → no hubo respuesta (red caída o tope de 30 s).
 */
export type MentionPaqoOutcome =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "rate-limited" | "unavailable" | "network" };

/** Drena un cuerpo SSE con TOPE y cancela el resto (no bloquea la conexión). */
async function drainCapped(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  try {
    for (let i = 0; i < MENTION_MAX_CHUNKS; i++) {
      if ((await reader.read()).done) return;
    }
    // Tope alcanzado: cortamos en vez de seguir leyendo indefinidamente.
    await reader.cancel();
  } catch {
    /* red caída a mitad del drenaje: nada que hacer */
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Dispara una respuesta pública de Paqo por una mención en el chat abierto.
 * No renderiza: la respuesta la reparte Realtime a todos cuando el servidor la
 * inserta. Devuelve el DESENLACE para que la UI pueda avisar si Paqo se saltó el
 * turno (cooldown/429) en vez de tragárselo en silencio.
 */
export async function mentionPaqoPublic(params: {
  biosphereId: string;
  messages: WireMessage[];
  sessionId?: string;
  /**
   * Nombre público (nickname) de quien menciona a Paqo. Se envía para que Paqo
   * pueda dirigirse a la persona por su nombre en el chat general. El servidor
   * lo sanitiza (longitud, control chars, comillas, bidi) y lo trata como un
   * NOMBRE, nunca como instrucción. Si se omite o queda vacío, todo igual.
   */
  speakerName?: string;
}): Promise<MentionPaqoOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/oracle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.sessionId ? { "x-session-id": params.sessionId } : {}),
      },
      body: JSON.stringify({
        oracleId: "paqo",
        mode: "public",
        biosphereId: params.biosphereId,
        messages: params.messages,
        ...(params.speakerName ? { speakerName: params.speakerName } : {}),
      }),
      // Sin tope, una conexión colgada dejaba el fetch (y su cuerpo) vivo para
      // siempre. El modelo ya corta a 30 s server-side.
      signal: AbortSignal.timeout(MENTION_TIMEOUT_MS),
    });
  } catch (err) {
    // Red/timeout: no es crítico, la mención del usuario ya se publicó.
    console.warn("[oracle] mención pública no respondida:", err);
    return { ok: false, reason: "network" };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Respuesta NO-SSE: o el 200 {skipped:"cooldown"} o un error con JSON.
    let data: { skipped?: string } | null = null;
    try {
      data = (await res.json()) as { skipped?: string };
    } catch {
      /* sin JSON legible */
    }
    if (res.ok && data?.skipped === "cooldown") return { ok: false, reason: "cooldown" };
    if (res.status === 429) return { ok: false, reason: "rate-limited" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    return { ok: true };
  }

  if (!res.ok) {
    if (res.body) await drainCapped(res.body);
    return { ok: false, reason: res.status === 429 ? "rate-limited" : "unavailable" };
  }

  // Drenamos el cuerpo para cerrar la conexión limpiamente; no lo usamos.
  if (res.body) await drainCapped(res.body);
  return { ok: true };
}

// --- Identidad persistida (nombre + tint del viajero) ------------------------
const NAME_KEY = "phy:displayName";
const TINT_KEY = "phy:tint";

/** Paleta de tints coherente con la marca (cerámica/dorado/índigo). */
const TINTS = ["#e3b063", "#c98a5e", "#d8c3a5", "#7a86c8", "#8db38b", "#c98aa8", "#6fb3b8"];

/**
 * TODO acceso a localStorage va envuelto en try/catch (patrón de avatar-store.ts):
 * en incógnito, con cookies de terceros bloqueadas o con la cuota llena, el mero
 * `localStorage.getItem` LANZA. Como `page.tsx` llama a estos helpers en el
 * ámbito de módulo, una excepción aquí mataba la evaluación del módulo entero y
 * la app quedaba EN BLANCO — justo el caso para el que existe el diagnóstico de
 * sesión (S14). Degradar en silencio es siempre preferible.
 */
export function pickTint(seed?: string): string {
  try {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(TINT_KEY);
      if (stored) return stored;
    }
  } catch {
    /* almacenamiento bloqueado: seguimos y derivamos el tint de la semilla */
  }
  let h = 0;
  const s = seed ?? Math.random().toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const tint = TINTS[Math.abs(h) % TINTS.length];
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(TINT_KEY, tint);
  } catch {
    /* no persistimos el tint; el color sigue siendo estable por semilla */
  }
  return tint;
}

export function getStoredName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(NAME_KEY);
  } catch {
    return null; // incógnito/almacenamiento bloqueado: como si no hubiera nombre
  }
}

export function storeName(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
  } catch {
    /* cuota llena / modo privado: el nombre vive sólo en esta sesión */
  }
}

// --- conversationId privado persistido ---------------------------------------
export function conversationKey(biosphereId: string): string {
  return `phy:paqo:conv:${biosphereId}`;
}
export function getStoredConversationId(biosphereId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(conversationKey(biosphereId));
  } catch {
    return null; // sin memoria persistente: Paqo empieza conversación nueva
  }
}
export function storeConversationId(biosphereId: string, id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(conversationKey(biosphereId), id);
  } catch {
    /* cuota llena / modo privado: no es crítico */
  }
}

/**
 * Registra que la persona ENCONTRÓ el Oráculo (señal "found"). Sólo para
 * usuarios registrados: actualiza `progress.found_oracles` vía el cliente
 * autenticado (RLS owner-only). Best-effort; los anónimos no persisten progreso.
 */
export async function markOracleFound(oracleId: string): Promise<void> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data: sessionData } = await supabase.auth.getSession();
    const user = sessionData.session?.user;
    if (!user || user.is_anonymous) return; // anónimo: sin progreso persistente

    const { data: row } = await supabase
      .from("progress")
      .select("found_oracles")
      .eq("user_id", user.id)
      .maybeSingle();
    const found: string[] = Array.isArray(row?.found_oracles) ? (row!.found_oracles as string[]) : [];
    if (found.includes(oracleId)) return;
    await supabase
      .from("progress")
      .update({ found_oracles: [...found, oracleId] })
      .eq("user_id", user.id);
  } catch (err) {
    console.warn("[progress] no se pudo marcar oráculo encontrado:", err);
  }
}
