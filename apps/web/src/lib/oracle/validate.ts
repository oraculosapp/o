/**
 * Validación de payload + moderación básica + saneo anti-inyección.
 *
 * Principio de seguridad clave: el mensaje del usuario JAMÁS se concatena al
 * system prompt. Los mensajes entrantes sólo pueden tener rol user/oracle; se
 * descarta cualquier intento de inyectar un rol "system". El system prompt lo
 * decide EXCLUSIVAMENTE el servidor vía getOracleSystemPrompt.
 */
import type { ChatMessage } from "./chat-model";
import { listOracles } from "@phygitalia/content";

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
  /**
   * Canal de Biósfera al que pertenece esta conversación (chat público). Sólo
   * relevante en `mode: "public"`: es la tabla/canal donde el Oráculo publica su
   * respuesta con `is_oracle = true`. Si se omite, el handler usa `oracleId`.
   */
  biosphereId?: string;
  /**
   * Nombre público (nickname) de quien habla en el chat general. Sólo se usa en
   * `mode: "public"` para que Paqo pueda dirigirse a la persona por su nombre.
   * Ya viene sanitizado por `validateOracleRequest` (recortado, sin control
   * chars, cap `MAX_SPEAKER_NAME_LEN`). Es DATO de usuario: el handler lo trata
   * como un nombre, nunca como instrucción. Ausente si venía vacío/ilegible.
   */
  speakerName?: string;
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
/** Tope del nickname del hablante inyectado en el prompt público. */
export const MAX_SPEAKER_NAME_LEN = 40;
/**
 * Tope del tamaño TOTAL de entrada por petición (suma de chars de `messages`).
 * Corta el vector "muchos mensajes casi-máximos" que quemaría presupuesto de
 * OpenAI aun respetando MAX_MESSAGE_LEN × MAX_MESSAGES (A-2).
 */
export const MAX_TOTAL_INPUT_CHARS = 6_000;

const ORACLE_ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Sanea el nickname del hablante para inyectarlo con seguridad en el prompt
 * público. Es DATO de usuario, así que:
 *  · aplana a espacio los saltos de línea, tabs, controles C0/C1/DEL y los
 *    separadores de línea/párrafo Unicode (evita colar líneas tipo "system:"),
 *  · BORRA invisibles y control BIDI (zero-width, LRM/RLM, embeddings,
 *    overrides, isolates, BOM): con ellos se reordena visualmente el marco del
 *    prompt o se esconde carga útil dentro de un nombre de aspecto inocente,
 *  · NEUTRALIZA comillas y barra invertida (" ' ` \) cambiándolas por sus
 *    equivalentes tipográficos: 40 chars bastaban para CERRAR la comilla del
 *    marco y escribir una instrucción a continuación,
 *  · colapsa espacios, recorta y capa a `MAX_SPEAKER_NAME_LEN` contando PUNTOS
 *    DE CÓDIGO (`slice` partía pares surrogate por la mitad).
 * Devuelve "" si no queda nada legible (el llamador lo trata como ausente).
 *
 * Es la PRIMERA barrera. La SEGUNDA es el marco con nonce aleatorio del handler:
 * aunque algo se colara, el atacante no puede adivinar el delimitador.
 */
export function sanitizeSpeakerName(raw: string): string {
  const cleaned = raw
    // Controles C0, DEL, C1 y separadores de línea/párrafo Unicode -> espacio.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    // Invisibles y control BIDI: fuera del todo (nada de eso es un "nombre").
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/g, "")
    // Comillas y barra: no pueden cerrar el delimitador del marco. Se sustituyen
    // (no se borran) para que O'Brien o «Ana "la roja"» sigan leyéndose bien.
    .replace(/"/g, "\u201D")
    .replace(/['`\u2018]/g, "\u2019")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  // Recorte por puntos de código: nunca parte un par surrogate (emoji, etc.).
  return Array.from(cleaned).slice(0, MAX_SPEAKER_NAME_LEN).join("").trim();
}

/**
 * LISTA BLANCA de Oráculos (A-1): la lista REAL de voces escritas del paquete de
 * contenido. Rechazar ids fuera de aquí impide falsificar/enrutar a un "Paqo"
 * inventado o inyectar un oracleId arbitrario en el chat público.
 */
const ALLOWED_ORACLE_IDS: ReadonlySet<string> = new Set(listOracles().map((o) => o.id));

/**
 * LISTA BLANCA de Biósferas (A-1). Aún no hay export de biósferas en
 * @phygitalia/content (sólo `getBiosphere` con registro parcial), así que fijamos
 * los ids conocidos de la beta (coinciden con los 6 Oráculos con voz). Esto
 * además cierra el bypass del cooldown público variando `biosphereId`: sólo los
 * canales conocidos pasan.
 */
const ALLOWED_BIOSPHERE_IDS: ReadonlySet<string> = new Set([
  "paqo",
  "cosmogenes",
  "eme-y-uru",
  "espinosito",
  "nin",
  "brangulio",
]);

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
  // Lista blanca real (A-1): sólo Oráculos existentes, nunca uno inventado.
  if (!ALLOWED_ORACLE_IDS.has(oracleId)) {
    return { ok: false, error: "oracleId desconocido." };
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
  let totalChars = 0;
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
    totalChars += content.length;
    // Tope del total acumulado (A-2): evita el vector "N mensajes casi-máximos".
    if (totalChars > MAX_TOTAL_INPUT_CHARS) {
      return { ok: false, error: `Entrada demasiado larga (máx ${MAX_TOTAL_INPUT_CHARS} chars).` };
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

  let biosphereId: string | undefined;
  if (b.biosphereId !== undefined) {
    if (typeof b.biosphereId !== "string" || !ORACLE_ID_RE.test(b.biosphereId)) {
      return { ok: false, error: "biosphereId inválido (usa [a-z0-9-], 1-64 chars)." };
    }
    // Lista blanca real (A-1): sólo canales de Biósfera conocidos. Cierra además
    // el bypass del cooldown público por biosphereId arbitrario.
    if (!ALLOWED_BIOSPHERE_IDS.has(b.biosphereId)) {
      return { ok: false, error: "biosphereId desconocido." };
    }
    biosphereId = b.biosphereId;
  }

  // Nombre del hablante (chat público). Opcional y saneado: es DATO de usuario,
  // no una instrucción. Si tras sanear queda vacío/ilegible, se omite (el prompt
  // se comporta como si no viniera nombre).
  let speakerName: string | undefined;
  if (b.speakerName !== undefined) {
    if (typeof b.speakerName !== "string") {
      return { ok: false, error: "speakerName debe ser string." };
    }
    const clean = sanitizeSpeakerName(b.speakerName);
    if (clean.length > 0) speakerName = clean;
  }

  return {
    ok: true,
    value: { oracleId, mode, messages, conversationId, biosphereId, speakerName },
  };
}

/**
 * Contexto del modelo en modo PÚBLICO (A-1). El historial de un chat abierto lo
 * controla el cliente y NO es de fiar: un atacante puede inyectar turnos
 * `role:"oracle"` para poner palabras en boca del Oráculo (falsificación) o para
 * inflar el contexto. Reconstruimos el contexto en el servidor: nos quedamos
 * SÓLO con el último mensaje del usuario (el turno a responder). El system prompt
 * lo antepone `buildChatMessages`, siempre server-side.
 */
export function publicWireMessages(messages: WireMessage[]): WireMessage[] {
  return [messages[messages.length - 1]];
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
