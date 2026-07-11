/**
 * Validación de payload + moderación básica + saneo anti-inyección.
 *
 * Principio de seguridad clave: el mensaje del usuario JAMÁS se concatena al
 * system prompt. Los mensajes entrantes sólo pueden tener rol user/oracle; se
 * descarta cualquier intento de inyectar un rol "system". El system prompt lo
 * decide EXCLUSIVAMENTE el servidor vía getOracleSystemPrompt.
 */
import type { ChatMessage } from "./chat-model";

export type OracleMode = "public" | "private";

/** Rol tal como llega del cliente (contrato de API). */
export type WireRole = "user" | "oracle";

export interface WireMessage {
  role: WireRole;
  content: string;
}

export interface OracleRequest {
  oracleId: string;
  mode: OracleMode;
  messages: WireMessage[];
  conversationId?: string;
}

export interface ValidationOk {
  ok: true;
  value: OracleRequest;
}
export interface ValidationErr {
  ok: false;
  error: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

// Límites de moderación (longitud).
export const MAX_MESSAGE_LEN = 2_000;
export const MAX_MESSAGES = 40;
export const MAX_ORACLE_ID_LEN = 64;

const ORACLE_ID_RE = /^[a-z0-9-]{1,64}$/;

/** Valida y normaliza el cuerpo POST. No lanza: devuelve ok/err. */
export function validateOracleRequest(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "El cuerpo debe ser un objeto JSON." };
  }
  const b = body as Record<string, unknown>;

  const oracleId = b.oracleId;
  if (typeof oracleId !== "string" || !ORACLE_ID_RE.test(oracleId)) {
    return { ok: false, error: "oracleId inválido (usa [a-z0-9-], 1-64 chars)." };
  }

  const mode = b.mode;
  if (mode !== "public" && mode !== "private") {
    return { ok: false, error: 'mode debe ser "public" o "private".' };
  }

  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, error: "messages debe ser un array no vacío." };
  }
  if (b.messages.length > MAX_MESSAGES) {
    return { ok: false, error: `Demasiados mensajes (máx ${MAX_MESSAGES}).` };
  }

  const messages: WireMessage[] = [];
  for (const raw of b.messages) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Cada mensaje debe ser un objeto." };
    }
    const m = raw as Record<string, unknown>;
    if (m.role !== "user" && m.role !== "oracle") {
      // Se rechaza explícitamente cualquier rol "system" u otro (anti-inyección).
      return { ok: false, error: 'role de mensaje inválido (sólo "user"/"oracle").' };
    }
    if (typeof m.content !== "string") {
      return { ok: false, error: "content de mensaje debe ser string." };
    }
    const content = m.content.trim();
    if (content.length === 0) {
      return { ok: false, error: "content de mensaje vacío." };
    }
    if (content.length > MAX_MESSAGE_LEN) {
      return { ok: false, error: `Mensaje demasiado largo (máx ${MAX_MESSAGE_LEN} chars).` };
    }
    messages.push({ role: m.role, content });
  }

  // El último mensaje debe ser del usuario (es el turno a responder).
  if (messages[messages.length - 1].role !== "user") {
    return { ok: false, error: "El último mensaje debe ser del usuario." };
  }

  let conversationId: string | undefined;
  if (b.conversationId !== undefined) {
    if (typeof b.conversationId !== "string" || b.conversationId.length > 64) {
      return { ok: false, error: "conversationId inválido." };
    }
    conversationId = b.conversationId;
  }

  return { ok: true, value: { oracleId, mode, messages, conversationId } };
}

/**
 * Convierte los mensajes del contrato (user/oracle) a mensajes de chat
 * (user/assistant), anteponiendo el system prompt del servidor. Los mensajes
 * del usuario NUNCA se funden con el system: van como turnos independientes.
 */
export function buildChatMessages(systemPrompt: string, wire: WireMessage[]): ChatMessage[] {
  const mapped: ChatMessage[] = wire.map((m) => ({
    role: m.role === "oracle" ? "assistant" : "user",
    content: m.content,
  }));
  return [{ role: "system", content: systemPrompt }, ...mapped];
}
