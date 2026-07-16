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
 */
export async function streamOracle(
  params: OracleStreamParams,
  cb: OracleStreamCallbacks
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/oracle", {
      method: "POST",
      headers: headersFor(params),
      body: bodyFor(params),
      signal: params.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    cb.onError?.("No se pudo contactar al Oráculo. Revisa tu conexión.");
    return;
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
      const { done, value } = await reader.read();
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
            cb.onDone?.();
            break;
        }
      }
    }
    cb.onDone?.();
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    cb.onError?.("Se interrumpió la respuesta del Oráculo.");
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Dispara una respuesta pública de Paqo por una mención en el chat abierto.
 * Fire-and-forget: no renderiza; la respuesta la reparte Realtime a todos. Si el
 * servidor responde con `{skipped:"cooldown"}` (200 no-SSE) simplemente termina.
 */
export async function mentionPaqoPublic(params: {
  biosphereId: string;
  messages: WireMessage[];
  sessionId?: string;
  /**
   * Nombre público (nickname) de quien menciona a Paqo. Se envía para que Paqo
   * pueda dirigirse a la persona por su nombre en el chat general. El servidor
   * lo sanitiza (longitud, control chars) y lo trata como un NOMBRE, nunca como
   * instrucción. Si se omite o queda vacío, el comportamiento es el de siempre.
   */
  speakerName?: string;
}): Promise<void> {
  try {
    const res = await fetch("/api/oracle", {
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
    });
    // Drenamos el cuerpo para cerrar la conexión limpiamente; no lo usamos.
    if (res.body) {
      const reader = res.body.getReader();
      // eslint-disable-next-line no-empty
      while (!(await reader.read()).done) {}
    }
  } catch (err) {
    // Cooldown/429/red: no es crítico, la mención del usuario ya se publicó.
    console.warn("[oracle] mención pública no respondida:", err);
  }
}

// --- Identidad persistida (nombre + tint del viajero) ------------------------
const NAME_KEY = "phy:displayName";
const TINT_KEY = "phy:tint";

/** Paleta de tints coherente con la marca (cerámica/dorado/índigo). */
const TINTS = ["#e3b063", "#c98a5e", "#d8c3a5", "#7a86c8", "#8db38b", "#c98aa8", "#6fb3b8"];

export function pickTint(seed?: string): string {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(TINT_KEY);
    if (stored) return stored;
  }
  let h = 0;
  const s = seed ?? Math.random().toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const tint = TINTS[Math.abs(h) % TINTS.length];
  if (typeof window !== "undefined") window.localStorage.setItem(TINT_KEY, tint);
  return tint;
}

export function getStoredName(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(NAME_KEY);
}

export function storeName(name: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
}

// --- conversationId privado persistido ---------------------------------------
export function conversationKey(biosphereId: string): string {
  return `phy:paqo:conv:${biosphereId}`;
}
export function getStoredConversationId(biosphereId: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(conversationKey(biosphereId));
}
export function storeConversationId(biosphereId: string, id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(conversationKey(biosphereId), id);
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
