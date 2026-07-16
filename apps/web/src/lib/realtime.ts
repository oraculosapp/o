/**
 * Orquestación de Supabase Realtime POR BIÓSFERA.
 *
 * Un único channel `biosphere:<id>` concentra cuatro flujos:
 *   (a) Presence  — roster de quién está en la Biósfera (id de sesión, nombre, tint).
 *   (b) Broadcast "pos" (10 Hz) — posición/anim de cada avatar → world.net.upsertRemote;
 *       si un remoto deja de emitir >5 s, se retira (removeRemote).
 *   (c) Broadcast "ball" — patadas al balón; autoridad = el último que la tocó.
 *   (d) postgres_changes en `biosphere_messages` — el chat público en vivo.
 *
 * Sesión: usa `ensureAnonSession()` (login anónimo si no hay sesión). Todo el
 * ciclo de vida (suscripción, reintentos del world.net, timeouts, limpieza) está
 * encapsulado aquí; la capa React sólo consume callbacks.
 *
 * Degradación: si Supabase no está configurado, `isSupabaseConfigured()` es false
 * y la capa de UI oculta el chat con un aviso discreto. Si `world.net` aún no
 * existe (el engine no lo montó), presencia/movimiento se omiten con gracia y el
 * chat sigue funcionando.
 */
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  RealtimePresenceState,
  Session,
  SupabaseClient,
} from "@supabase/supabase-js";
import { isEmoteId } from "@phygitalia/engine";
import { ensureAnonSession, getSupabaseBrowserClient } from "./supabase";
import { getStoredArchetype, getStoredPrimaryTint } from "./avatar-store";
import { isArchetypeId, isAvatarId } from "./avatars";
import type { GameEventUi, WorldGameHooks } from "./world-ui";

// --- Contrato con el engine (lo implementa el equipo PaqoWorld) --------------
export interface WorldNetHooks {
  getLocalState(): { pos: [number, number, number]; yaw: number; anim: "idle" | "walk" | "run" | "jump" };
  onLocalTick(
    cb: (s: ReturnType<WorldNetHooks["getLocalState"]>) => void,
    hz?: number
  ): () => void;
  upsertRemote(
    id: string,
    s: {
      pos: [number, number, number];
      yaw: number;
      anim: string;
      tint?: string;
      name?: string;
      /** Id del arquetipo PROCEDURAL del remoto (p.ej. "vampiro"). */
      archetype?: string;
    }
  ): void;
  removeRemote(id: string): void;
  onBallKick(
    cb: (ballId: number, s: { pos: [number, number, number]; vel: [number, number, number] }) => void
  ): () => void;
  applyBallState(
    ballId: number,
    s: { pos: [number, number, number]; vel: [number, number, number] }
  ): void;
  /**
   * Suscribe AGARRES locales de balón (primero o robo) → difundir "ball_grab".
   * Opcionales (`?`) para degradar con gracia si el engine aún no expone la feature
   * de robo; se invocan con optional-chaining.
   */
  onBallGrab?(cb: (ballId: number, t: number) => void): () => void;
  /** Aplica un agarre remoto ("ball_grab"): puede provocar un force-drop del portador. */
  applyBallGrab?(ballId: number, by: string, t: number): void;
  /** Fija el id del jugador local (desempate de robos por id). */
  setLocalId?(id: string): void;
  onZoneSignal(cb: (signal: "far" | "mid" | "near" | "found") => void): () => void;
  /**
   * EMOTES (equipo Avatar). Opcionales (`?`) para degradar con gracia si el engine
   * aún no los expone: se suscribe a los emotes LOCALES (para difundir "emote") y
   * se aplican los emotes REMOTOS al avatar correspondiente.
   */
  onLocalEmote?(cb: (emote: string) => void): () => void;
  applyRemoteEmote?(id: string, emote: string): void;
  /**
   * DIBUJAR (equipo Vuelo/Mandos). Opcionales (`?`) para degradar con gracia si el
   * engine aún no los expone: se suscribe a los LOTES locales del trazo arcoíris
   * (para difundir "draw", ≤40 puntos cada ~0.5 s) y se aplican los lotes REMOTOS
   * al mismo sistema de pintado (DrawTrail).
   */
  onDrawBatch?(cb: (b: { stroke: number; points: number[] }) => void): () => void;
  applyDrawBatch?(by: string, b: { stroke: number; points: number[] }): void;
}

// --- Tipos de dominio --------------------------------------------------------
export interface BiosphereMessage {
  id: string;
  biosphere_id: string;
  user_id: string | null;
  display_name: string;
  content: string;
  is_oracle: boolean;
  /**
   * true si el autor es anónimo (sin perfil registrado). Lo fija el servidor
   * (trigger de la migración 0003_hardening); para usuarios registrados el
   * servidor además SOBREESCRIBE display_name con su handle. La UI puede usar
   * esta bandera para distinguir anónimos (p.ej. un matiz visual). Opcional para
   * tolerar filas antiguas anteriores a 0003.
   */
  is_anon?: boolean;
  created_at: string;
}

export interface RosterMember {
  id: string;
  display_name: string;
  tint?: string;
  archetype?: string;
}

export type RealtimeStatus = "idle" | "connecting" | "live" | "error";

/**
 * Categoría AMABLE del fallo de sesión, para comunicar la CAUSA real al viajero
 * (no un genérico "recarga la página"):
 *   · "storage"  — el navegador bloquea localStorage/cookies (típico de modo
 *                  incógnito): la sesión persistente de Supabase no puede vivir.
 *   · "captcha"  — Turnstile / la verificación anti-bots de Supabase falló.
 *   · "red"      — falló el fetch al servidor (sin conexión / red restrictiva).
 *   · "otro"     — cualquier otro fallo; se acompaña de un código corto legible.
 */
export type SessionErrorCategory = "storage" | "captcha" | "red" | "otro";

export interface SessionErrorInfo {
  category: SessionErrorCategory;
  /** Mensaje corto y accionable para pintar al viajero. */
  message: string;
  /**
   * Código corto (≤80 chars) del error original — sólo en la categoría "otro",
   * para que Julio nos lo pueda leer por teléfono al diagnosticar.
   */
  code?: string;
}

export interface RealtimeIdentity {
  /** id de sesión (uid de Supabase, anónimo o registrado). */
  sessionId: string;
  displayName: string;
  tint: string;
  /** Id del arquetipo procedural elegido (si hay), para que los demás te vean así. */
  archetype?: string;
  /** true si la sesión es de un usuario registrado (no anónimo). */
  registered: boolean;
  accessToken: string | null;
}

export interface RealtimeCallbacks {
  onRoster?(members: RosterMember[]): void;
  onMessage?(msg: BiosphereMessage): void;
  onStatus?(status: RealtimeStatus): void;
  /**
   * La sesión falló DE PLANO (tras agotar reintentos o por almacenamiento
   * bloqueado). Llega junto con `onStatus("error")` y trae la causa AMABLE para
   * que la UI muestre qué pasó (incógnito / captcha / red / otro) y ofrezca
   * "Reintentar". Se limpia (no se re-emite) en un reintento con éxito.
   */
  onSessionError?(info: SessionErrorInfo): void;
}

export interface BiosphereRealtimeOptions extends RealtimeCallbacks {
  biosphereId: string;
  /** Getter perezoso del world.net del engine (puede no existir todavía). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
  /**
   * Getter perezoso del mini-juego `world.game` (equipo Juego). Puede no existir
   * todavía; se engancha al MISMO canal `biosphere:<id>` (broadcast "game"), sin
   * crear una segunda suscripción. Si falta, el juego funciona 100% local.
   */
  getWorldGame?: () => WorldGameHooks | null | undefined;
  displayName: string;
  tint: string;
}

const POS_HZ = 10;
const REMOTE_TIMEOUT_MS = 5_000;
const SWEEP_MS = 1_000;
const NET_RETRY_MS = 600;
const NET_RETRY_MAX = 20; // ~12 s intentando enganchar world.net

/**
 * Backoff de reintentos de `ensureAnonSession` en `connect()`. El bug de prod:
 * en visitantes frescos el signup anónimo puede fallar (captcha interactivo,
 * arranque en 2º plano en móvil, glitch de red) y ese usuario quedaba INVISIBLE
 * en multijugador para siempre. Ahora reintentamos 3 veces con backoff creciente
 * (2 s / 8 s / 20 s) tras el intento inicial; los retos interactivos de Turnstile
 * tardan, así que damos margen. Si aun así falla, queda armado un último reintento
 * en `visibilitychange→visible` (caso móvil: la pestaña arrancó en segundo plano).
 */
const SESSION_RETRY_BACKOFFS_MS = [2_000, 8_000, 20_000];

/**
 * Valida que un `archetype` recibido por broadcast sea (a) el diseño "nube"
 * (S8, el avatar por defecto de todos), (b) uno de los 9 ids PROCEDURALES viejos,
 * o (c) un id de avatar MODELADO `"<arquetipo>-<f|m|n>"` (M-5). El broadcast no es
 * de fiar: al aceptar SÓLO ids de una lista blanca fija (nunca una URL arbitraria),
 * un emisor malicioso no puede inducir descargas externas — el engine sólo resuelve
 * el id a `/assets/avatars/gen/…` same-origin (o construye el chibi en código).
 * Devuelve el id si es válido, o `undefined`.
 */
function safeArchetype(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return undefined;
  return id === "nube" || isArchetypeId(id) || isAvatarId(id) ? id : undefined;
}

/** ¿Están las env vars públicas de Supabase presentes? (decide si hay chat). */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// --- Diagnóstico de la causa del fallo de sesión -----------------------------

/** Extrae el `.message` de un error-like (Error / string / objeto) de forma segura. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/**
 * ¿El navegador permite el almacenamiento que Supabase necesita? Comprueba
 * `navigator.cookieEnabled` y un ciclo real `setItem/removeItem` de localStorage
 * (donde vive la sesión persistente). En incógnito / almacenamiento restringido
 * esto falla o lanza → devolvemos false y atajamos con un motivo claro ANTES de
 * gastar reintentos de red. Robusto ante navegadores que LANZAN al mero acceder
 * a `localStorage` (todo va en try/catch).
 */
export function storageHealthy(): boolean {
  try {
    if (typeof navigator !== "undefined" && navigator.cookieEnabled === false) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = "__phy_storage_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Motivo fijo cuando el almacenamiento está bloqueado (incógnito): accionable. */
export const STORAGE_SESSION_ERROR: SessionErrorInfo = {
  category: "storage",
  message:
    "Tu navegador está bloqueando el almacenamiento (¿modo incógnito?). " +
    "Abre o.oraculos.app en una pestaña normal para jugar con los demás.",
};

/** Clasifica un error de sesión en una de las categorías amables (sin "storage"). */
function categorizeSessionError(err: unknown): Exclude<SessionErrorCategory, "storage"> {
  const msg = errorMessage(err).toLowerCase();
  if (/captcha|turnstile/.test(msg)) return "captcha";
  // Fallos de fetch/red: TypeError "Failed to fetch", AuthRetryableFetchError,
  // "NetworkError", "network request failed", etc.
  if (/failed to fetch|networkerror|network request|network error|fetch\b|econn|timeout/.test(msg)) {
    return "red";
  }
  return "otro";
}

/**
 * Traduce un error de sesión en un {@link SessionErrorInfo} con la causa AMABLE.
 * Función PURA (sin DOM ni red) → se testea en node. El caso "storage" no pasa por
 * aquí: se detecta antes con {@link storageHealthy} → {@link STORAGE_SESSION_ERROR}.
 */
export function describeSessionError(err: unknown): SessionErrorInfo {
  const category = categorizeSessionError(err);
  if (category === "captcha") {
    return { category, message: "La verificación anti-bots no pudo completarse. Reintenta." };
  }
  if (category === "red") {
    return { category, message: "Sin conexión con el servidor. Reintenta." };
  }
  const code = errorMessage(err).replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    category: "otro",
    message: code
      ? `No pudimos preparar tu sesión. Reintenta. (${code})`
      : "No pudimos preparar tu sesión. Reintenta.",
    code: code || undefined,
  };
}

interface PosPayload {
  id: string;
  pos: [number, number, number];
  yaw: number;
  anim: string;
  tint?: string;
  name?: string;
  archetype?: string;
}
interface BallPayload {
  by: string;
  ballId: number;
  pos: [number, number, number];
  vel: [number, number, number];
}
/**
 * Sobre de "ball_grab": quién agarró qué balón y cuándo. Difundido en TODO agarre
 * (primero o robo). El receptor que llevaba ese balón lo suelta si `t` es más nuevo
 * (empate → gana el id lexicográfico menor); la autoridad del balón pasa al emisor.
 */
interface BallGrabPayload {
  by: string;
  ballId: number;
  t: number;
}
/** Sobre de "emote": quién disparó qué emote sobre su propio avatar. */
interface EmotePayload {
  id: string;
  emote: string;
}
/**
 * [DIBUJO — equipo Vuelo/Mandos] Sobre de "draw": un LOTE de puntos del trazo
 * arcoíris del emisor. `stroke` identifica el trazo (monótono por emisor) para que
 * los lotes sucesivos se unan en una línea continua; `points` es plano
 * [x,y,z, x,y,z, …] con ≤ DRAW_BATCH_MAX_POINTS puntos (batch cada ~0.5 s).
 */
interface DrawPayload {
  id: string;
  stroke: number;
  points: number[];
}

/** Sobre del evento del mini-juego por broadcast: el GameEvent + el id del emisor. */
type GamePayload = GameEventUi & { id: string };

/** ¿`n` es un número finito? (los broadcasts no son de fiar; M-5). */
function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** ¿`v` es una terna [x,y,z] de números finitos? */
function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNum);
}

// ---- [DIBUJO — equipo Vuelo/Mandos] validación M-5 del flujo "draw" ----------

/** Tope de puntos por lote de dibujo (el engine emite ≤40; el broadcast no es de fiar). */
const DRAW_BATCH_MAX_POINTS = 40;

/**
 * Valida un lote de dibujo recibido por broadcast (M-5): `stroke` finito, `points`
 * array plano de números FINITOS, longitud múltiplo de 3 y ≤ 40 puntos (120
 * números). Devuelve el lote limpio o null. NUNCA confía en la forma entrante.
 */
function parseDrawBatch(payload: unknown): { stroke: number; points: number[] } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!isFiniteNum(p.stroke)) return null;
  const pts = p.points;
  if (!Array.isArray(pts)) return null;
  if (pts.length === 0 || pts.length % 3 !== 0) return null;
  if (pts.length > DRAW_BATCH_MAX_POINTS * 3) return null;
  if (!pts.every(isFiniteNum)) return null;
  return { stroke: p.stroke, points: pts as number[] };
}

/**
 * Valida y normaliza un evento de mini-juego recibido por broadcast (M-5): tipo en
 * lista blanca, números finitos, `scores` sano (objeto ≤64 claves con valores
 * finitos), strings cortos. Devuelve un {@link GameEventUi} limpio (sin el `id` del
 * sobre) o null si algo no cuadra. NUNCA confía en la forma del payload entrante.
 */
function parseGameEvent(payload: unknown): GameEventUi | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const short = (s: unknown): s is string => typeof s === "string" && s.length <= 64;
  switch (p.type) {
    case "start":
      if (!short(p.by) || !isFiniteNum(p.endsAt)) return null;
      return { type: "start", by: p.by, endsAt: p.endsAt };
    case "stop":
      if (!short(p.by)) return null;
      return { type: "stop", by: p.by };
    case "hit":
      if (!short(p.by) || !isFiniteNum(p.ballId) || !isVec3(p.hitPos)) return null;
      return { type: "hit", by: p.by, ballId: p.ballId, hitPos: p.hitPos };
    case "state": {
      if (!short(p.startedBy) || !isFiniteNum(p.endsAt)) return null;
      const raw = p.scores;
      if (!raw || typeof raw !== "object") return null;
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > 64) return null;
      const scores: Record<string, number> = {};
      for (const [k, v] of entries) {
        if (k.length > 64 || !isFiniteNum(v)) return null;
        scores[k] = v;
      }
      return { type: "state", endsAt: p.endsAt, scores, startedBy: p.startedBy };
    }
    default:
      return null;
  }
}

export class BiosphereRealtime {
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private identity: RealtimeIdentity | null = null;

  private readonly lastSeen = new Map<string, number>();
  /**
   * Ids de sesión presentes en el canal (roster de presence). Los broadcasts de
   * pos/ball de un emisor que NO está en presence se ignoran (defensa barata
   * anti-griefing, M-5): sin esto, cualquiera con la anon-key podría inyectar
   * movimiento/patadas sin figurar en el roster.
   */
  private readonly presentIds = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private netRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private netUnsubs: Array<() => void> = [];
  private netWired = false;
  private gameWired = false;
  private gameRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Timer del backoff de reintentos de sesión (se limpia al disponer). */
  private sessionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Listener del reintento móvil (visibilitychange); null si no está armado. */
  private onVisibility: (() => void) | null = null;
  /** Sólo se permite UN reintento extra por visibilitychange (no reencolar). */
  private visibilityRetryUsed = false;
  /** Último motivo del fallo de sesión (para exponerlo y para el botón Reintentar). */
  private lastSessionError: SessionErrorInfo | null = null;

  constructor(private readonly opts: BiosphereRealtimeOptions) {}

  getIdentity(): RealtimeIdentity | null {
    return this.identity;
  }

  /** Último motivo del fallo de sesión, o null si no ha fallado (aún). */
  getSessionError(): SessionErrorInfo | null {
    return this.lastSessionError;
  }

  /** Arranca sesión + canal. Idempotente: reconectar tras dispose crea uno nuevo. */
  async connect(): Promise<void> {
    if (this.disposed || this.identity) return;
    this.opts.onStatus?.("connecting");
    // Atajo directo: si el navegador bloquea almacenamiento/cookies (típico de
    // incógnito), la sesión persistente de Supabase (persistSession → localStorage)
    // NO puede vivir. No gastamos reintentos de red: comunicamos la causa real y
    // dejamos que el viajero abra una pestaña normal (o reintente si desbloquea).
    if (!storageHealthy()) {
      this.failSession(STORAGE_SESSION_ERROR);
      return;
    }
    const session = await this.acquireSessionWithRetry();
    if (this.disposed || this.identity) return;
    if (!session) {
      // Agotados los reintentos con backoff: deja armado un ÚLTIMO intento para
      // cuando la pestaña vuelva a primer plano (móvil: arrancó en 2º plano).
      this.armVisibilityRetry();
      this.failSession(this.lastSessionError ?? describeSessionError(undefined));
      return;
    }
    this.establish(session);
  }

  /** Fija el motivo del fallo, lo emite y pone el estado en "error". */
  private failSession(info: SessionErrorInfo): void {
    this.lastSessionError = info;
    this.opts.onSessionError?.(info);
    this.opts.onStatus?.("error");
  }

  /**
   * Reintento MANUAL de conexión (botón "Reintentar" de la UI). Resetea los guards
   * de reintento, limpia timers y cualquier canal a medias (para no duplicar) y
   * vuelve a {@link connect}. No hace nada si ya estamos conectados o dispuestos.
   */
  async retryConnect(): Promise<void> {
    if (this.disposed || this.identity) return;
    // Corta timers de reintento en vuelo (backoff de sesión + visibility) para
    // arrancar limpio; permite de nuevo el reintento por visibilitychange.
    if (this.sessionRetryTimer) {
      clearTimeout(this.sessionRetryTimer);
      this.sessionRetryTimer = null;
    }
    this.teardownVisibilityRetry();
    this.visibilityRetryUsed = false;
    // Si un intento anterior dejó un canal a medias, límpialo antes de reconectar
    // (evita canales duplicados sobre `biosphere:<id>`).
    if (this.channel) {
      if (this.supabase) void this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.lastSessionError = null;
    await this.connect();
  }

  /**
   * Pide la sesión anónima con backoff. Intento inmediato + 3 reintentos
   * (2 s / 8 s / 20 s). Loggea cada fallo con el warn accionable. Devuelve la
   * sesión, o null si se agotan los intentos (o si nos disponen por el camino).
   */
  private async acquireSessionWithRetry(): Promise<Session | null> {
    const backoffs = SESSION_RETRY_BACKOFFS_MS;
    const total = backoffs.length + 1;
    for (let attempt = 0; attempt < total; attempt++) {
      if (this.disposed) return null;
      try {
        return await ensureAnonSession();
      } catch (err) {
        const isLast = attempt === total - 1;
        // Guarda la causa AMABLE del último error para exponerla si se agotan
        // los intentos (captcha / red / otro con código corto).
        this.lastSessionError = describeSessionError(err);
        console.warn(
          `[realtime] no se pudo iniciar sesión anónima (intento ${attempt + 1}/${total}` +
            `${isLast ? ", último" : `, reintento en ${backoffs[attempt] / 1000}s`}):`,
          err
        );
        if (isLast) return null;
        await this.delay(backoffs[attempt]);
        if (this.disposed) return null;
      }
    }
    return null;
  }

  /** Espera `ms` de forma cancelable (el timer se limpia en `disconnect`). */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sessionRetryTimer = setTimeout(resolve, ms);
    });
  }

  /** Con sesión ya obtenida: fija identidad y suscribe el canal. */
  private establish(session: Session): void {
    this.teardownVisibilityRetry();
    if (this.sessionRetryTimer) {
      clearTimeout(this.sessionRetryTimer);
      this.sessionRetryTimer = null;
    }
    try {
      this.lastSessionError = null; // sesión obtenida: el fallo previo (si hubo) ya no aplica
      this.supabase = getSupabaseBrowserClient();
      const user = session.user;
      this.identity = {
        sessionId: user.id,
        displayName: this.opts.displayName,
        // El color/arquetipo del avatar elegido manda sobre el tinte por defecto.
        tint: getStoredPrimaryTint() ?? this.opts.tint,
        archetype: getStoredArchetype(),
        registered: user.is_anonymous !== true,
        accessToken: session.access_token ?? null,
      };
      this.subscribe();
    } catch (err) {
      console.warn("[realtime] no se pudo montar el canal tras la sesión:", err);
      this.failSession(describeSessionError(err));
    }
  }

  /**
   * Arma un ÚNICO reintento de `connect()` para cuando la pestaña vuelva a ser
   * visible. Caso móvil real: el navegador arranca la página en segundo plano
   * (pestaña oculta) y Turnstile / el signup fallan; al traer la pestaña al
   * frente reintentamos una vez más. No se reencola tras usarse.
   */
  private armVisibilityRetry(): void {
    if (this.disposed || this.visibilityRetryUsed || this.onVisibility) return;
    if (typeof document === "undefined") return;
    const handler = () => {
      if (this.disposed || document.visibilityState !== "visible") return;
      if (this.identity) return; // ya conectamos por otra vía
      this.visibilityRetryUsed = true;
      this.teardownVisibilityRetry();
      console.warn(
        "[realtime] reintento de sesión anónima al volver la pestaña a primer plano (caso móvil)…"
      );
      void this.connect();
    };
    this.onVisibility = handler;
    document.addEventListener("visibilitychange", handler);
  }

  private teardownVisibilityRetry(): void {
    if (this.onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.onVisibility = null;
  }

  private subscribe(): void {
    if (!this.supabase || !this.identity) return;
    const { biosphereId } = this.opts;
    const me = this.identity;

    const channel = this.supabase.channel(`biosphere:${biosphereId}`, {
      config: {
        presence: { key: me.sessionId },
        broadcast: { self: false },
      },
    });

    // (a) Presence — roster
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as RealtimePresenceState<{
        id: string;
        display_name: string;
        tint?: string;
        archetype?: string;
      }>;
      const members: RosterMember[] = [];
      const names: Record<string, string> = {};
      this.presentIds.clear();
      for (const key of Object.keys(state)) {
        const meta = state[key][0];
        if (!meta) continue;
        const id = meta.id ?? key;
        // La presence key es autoritativa (la fija Supabase = uid de la sesión);
        // registramos AMBOS por si el meta.id difiere, para el guard de pos/ball.
        this.presentIds.add(id);
        this.presentIds.add(key);
        const display_name = meta.display_name ?? "Viajero";
        names[id] = display_name;
        members.push({
          id,
          display_name,
          tint: meta.tint,
          // Sólo ids de arquetipo válidos (lista blanca) llegan al engine (M-5).
          archetype: safeArchetype(meta.archetype),
        });
      }
      this.opts.onRoster?.(members);
      // El mini-juego resuelve nombres SIN una segunda suscripción: le pasamos el
      // roster de presence (sticky en BallGame) para pintar el marcador.
      this.game()?.mergeNames?.(names);
    });

    // (b) Broadcast "pos" — avatares remotos
    channel.on("broadcast", { event: "pos" }, ({ payload }: { payload: PosPayload }) => {
      if (!payload || payload.id === me.sessionId) return;
      // Anti-griefing (M-5): ignora a quien no figura en el roster de presence.
      if (!this.presentIds.has(payload.id)) return;
      const net = this.net();
      this.lastSeen.set(payload.id, Date.now());
      net?.upsertRemote(payload.id, {
        pos: payload.pos,
        yaw: payload.yaw,
        anim: payload.anim,
        tint: payload.tint,
        name: payload.name,
        // Sólo ids de arquetipo válidos (lista blanca) pasan al engine (M-5).
        archetype: safeArchetype(payload.archetype),
      });
    });

    // (c) Broadcast "ball" — autoridad = último que la tocó (el emisor)
    channel.on("broadcast", { event: "ball" }, ({ payload }: { payload: BallPayload }) => {
      if (!payload || payload.by === me.sessionId) return;
      // Anti-griefing (M-5): sólo aceptamos patadas de emisores presentes.
      if (!this.presentIds.has(payload.by)) return;
      this.net()?.applyBallState(payload.ballId, { pos: payload.pos, vel: payload.vel });
    });

    // (c1) Broadcast "ball_grab" — agarre/robo de balón (autoridad pasa al emisor)
    channel.on("broadcast", { event: "ball_grab" }, ({ payload }: { payload: BallGrabPayload }) => {
      if (!payload || payload.by === me.sessionId) return;
      // Anti-griefing (M-5) idéntica a pos/ball: emisor presente + forma sana.
      if (typeof payload.by !== "string" || !this.presentIds.has(payload.by)) return;
      if (!isFiniteNum(payload.ballId) || !isFiniteNum(payload.t)) return;
      this.net()?.applyBallGrab?.(payload.ballId, payload.by, payload.t);
    });

    // (c2) Broadcast "game" — eventos del mini-juego ¡Dale a Paqo!
    channel.on("broadcast", { event: "game" }, ({ payload }: { payload: GamePayload }) => {
      if (!payload || payload.id === me.sessionId) return;
      // Anti-griefing (M-5): sólo emisores presentes; y valida la forma del evento.
      if (typeof payload.id !== "string" || !this.presentIds.has(payload.id)) return;
      const event = parseGameEvent(payload);
      if (event) this.game()?.applyRemote?.(event);
    });

    // (c3) [EMOTE — equipo Avatar] Broadcast "emote" — emote sobre el propio
    // avatar del emisor. Lista blanca EMOTE_IDS del engine (M-5).
    channel.on("broadcast", { event: "emote" }, ({ payload }: { payload: EmotePayload }) => {
      if (!payload || payload.id === me.sessionId) return;
      // Anti-griefing (M-5): emisor presente + emote en la lista blanca.
      if (typeof payload.id !== "string" || !this.presentIds.has(payload.id)) return;
      if (typeof payload.emote !== "string" || !isEmoteId(payload.emote)) return;
      this.net()?.applyRemoteEmote?.(payload.id, payload.emote);
    });

    // (c4) [DIBUJO — equipo Vuelo/Mandos] Broadcast "draw" — lotes del trazo
    // arcoíris de cada emisor. Misma defensa M-5 que pos/ball: emisor presente +
    // forma validada (≤40 puntos [x,y,z] finitos por lote). Los trazos remotos se
    // pintan con el MISMO DrawTrail (segmentos independientes por emisor+stroke).
    channel.on("broadcast", { event: "draw" }, ({ payload }: { payload: DrawPayload }) => {
      if (!payload || payload.id === me.sessionId) return;
      if (typeof payload.id !== "string" || !this.presentIds.has(payload.id)) return;
      const batch = parseDrawBatch(payload);
      if (batch) this.net()?.applyDrawBatch?.(payload.id, batch);
    });

    // (d) postgres_changes — chat público
    channel.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "biosphere_messages",
        filter: `biosphere_id=eq.${biosphereId}`,
      },
      (change: RealtimePostgresChangesPayload<BiosphereMessage>) => {
        const row = change.new as BiosphereMessage | undefined;
        if (row && row.id) this.opts.onMessage?.(row);
      }
    );

    channel.subscribe((status) => {
      if (this.disposed) return;
      if (status === "SUBSCRIBED") {
        this.opts.onStatus?.("live");
        void channel.track({
          id: me.sessionId,
          display_name: me.displayName,
          tint: me.tint,
          archetype: me.archetype,
        });
        this.wireWorldNet();
        this.wireGame();
        this.startSweep();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        this.opts.onStatus?.("error");
      }
    });

    this.channel = channel;
  }

  private net(): WorldNetHooks | null {
    return this.opts.getWorldNet?.() ?? null;
  }

  private game(): WorldGameHooks | null {
    return this.opts.getWorldGame?.() ?? null;
  }

  /** Engancha los hooks del engine; reintenta si world.net aún no existe. */
  private wireWorldNet(retry = 0): void {
    if (this.disposed || this.netWired) return;
    const net = this.net();
    if (!net) {
      if (retry < NET_RETRY_MAX) {
        this.netRetryTimer = setTimeout(() => this.wireWorldNet(retry + 1), NET_RETRY_MS);
      }
      return;
    }
    this.netWired = true;

    // Identidad local para el desempate de robos (id lexicográfico menor gana empate).
    if (this.identity) net.setLocalId?.(this.identity.sessionId);

    // Emite mi estado a 10 Hz por broadcast.
    const stopTick = net.onLocalTick((s) => {
      const me = this.identity;
      const ch = this.channel;
      if (!me || !ch) return;
      // Lee tinte/arquetipo frescos: si el viajero cambia de avatar en caliente,
      // los demás lo ven al instante (sin tocar el chat ni reconectar).
      void ch.send({
        type: "broadcast",
        event: "pos",
        payload: {
          id: me.sessionId,
          pos: s.pos,
          yaw: s.yaw,
          anim: s.anim,
          tint: getStoredPrimaryTint() ?? me.tint,
          name: me.displayName,
          archetype: getStoredArchetype() ?? me.archetype,
        } satisfies PosPayload,
      });
    }, POS_HZ);

    // Reenvía cada patada al balón (autoridad local). Este MISMO flujo transporta el
    // balón AGARRADO (difundido a ~10 Hz por el portador) y los respawns.
    const stopKick = net.onBallKick((ballId, s) => {
      const me = this.identity;
      const ch = this.channel;
      if (!me || !ch) return;
      void ch.send({
        type: "broadcast",
        event: "ball",
        payload: { by: me.sessionId, ballId, pos: s.pos, vel: s.vel } satisfies BallPayload,
      });
    });

    // Reenvía cada AGARRE local (primero o robo) como "ball_grab".
    const stopGrab = net.onBallGrab?.((ballId, t) => {
      const me = this.identity;
      const ch = this.channel;
      if (!me || !ch) return;
      void ch.send({
        type: "broadcast",
        event: "ball_grab",
        payload: { by: me.sessionId, ballId, t } satisfies BallGrabPayload,
      });
    });

    // [EMOTE — equipo Avatar] Reenvía cada EMOTE local (el jugador emotea sobre
    // su propio avatar) como "emote".
    const stopEmote = net.onLocalEmote?.((emote) => {
      const me = this.identity;
      const ch = this.channel;
      if (!me || !ch) return;
      void ch.send({
        type: "broadcast",
        event: "emote",
        payload: { id: me.sessionId, emote } satisfies EmotePayload,
      });
    });

    // [DIBUJO — equipo Vuelo/Mandos] Reenvía cada LOTE local del trazo arcoíris
    // como "draw" (el engine ya lo emite troceado: ≤40 puntos cada ~0.5 s).
    const stopDraw = net.onDrawBatch?.((b) => {
      const me = this.identity;
      const ch = this.channel;
      if (!me || !ch) return;
      void ch.send({
        type: "broadcast",
        event: "draw",
        payload: { id: me.sessionId, stroke: b.stroke, points: b.points } satisfies DrawPayload,
      });
    });

    this.netUnsubs.push(stopTick, stopKick);
    if (stopGrab) this.netUnsubs.push(stopGrab);
    if (stopEmote) this.netUnsubs.push(stopEmote);
    if (stopDraw) this.netUnsubs.push(stopDraw);
  }

  /**
   * Engancha el mini-juego `world.game` al MISMO canal (broadcast "game"); reintenta
   * si el engine aún no lo montó. Registra al jugador local, siembra su nombre y
   * reenvía cada evento local con el id del emisor. Igual patrón de retry que
   * {@link wireWorldNet}.
   */
  private wireGame(retry = 0): void {
    if (this.disposed || this.gameWired) return;
    const game = this.game();
    const me = this.identity;
    if (!game || !me) {
      if (retry < NET_RETRY_MAX) {
        this.gameRetryTimer = setTimeout(() => this.wireGame(retry + 1), NET_RETRY_MS);
      }
      return;
    }
    this.gameWired = true;

    game.setLocalPlayer?.(me.sessionId);
    // Siembra mi propio nombre para que el marcador me muestre bien desde el primer
    // frame (el resto del roster llega por presence sync → mergeNames).
    game.mergeNames?.({ [me.sessionId]: me.displayName });

    const stopGame = game.onLocalEvent?.((e) => {
      const ch = this.channel;
      if (!ch) return;
      void ch.send({
        type: "broadcast",
        event: "game",
        payload: { ...e, id: me.sessionId } satisfies GamePayload,
      });
    });
    if (stopGame) this.netUnsubs.push(stopGame);
  }

  /** Retira avatares remotos que dejaron de emitir hace >5 s. */
  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      const net = this.net();
      for (const [id, t] of this.lastSeen) {
        if (now - t > REMOTE_TIMEOUT_MS) {
          net?.removeRemote(id);
          this.lastSeen.delete(id);
        }
      }
    }, SWEEP_MS);
  }

  /** Actualiza nombre/tint visibles (presence) sin reconectar. */
  async setIdentity(partial: { displayName?: string; tint?: string }): Promise<void> {
    if (!this.identity) return;
    if (partial.displayName) this.identity.displayName = partial.displayName;
    if (partial.tint) this.identity.tint = partial.tint;
    if (this.channel) {
      await this.channel.track({
        id: this.identity.sessionId,
        display_name: this.identity.displayName,
        tint: this.identity.tint,
      });
    }
  }

  /**
   * Inserta un mensaje del usuario en el chat público. Devuelve la fila creada
   * (para eco optimista) o null si falla. postgres_changes también la reenvía;
   * la capa de UI deduplica por `id`.
   */
  async sendMessage(text: string): Promise<BiosphereMessage | null> {
    if (!this.supabase || !this.identity) return null;
    const content = text.trim().slice(0, 280);
    if (content.length === 0) return null;
    const me = this.identity;
    try {
      const { data, error } = await this.supabase
        .from("biosphere_messages")
        .insert({
          biosphere_id: this.opts.biosphereId,
          user_id: me.registered ? me.sessionId : null,
          display_name: me.displayName,
          content,
          is_oracle: false,
        })
        .select("*")
        .single();
      if (error) {
        console.warn("[realtime] insert de mensaje falló:", error.message);
        return null;
      }
      return data as BiosphereMessage;
    } catch (err) {
      console.warn("[realtime] insert de mensaje lanzó:", err);
      return null;
    }
  }

  /** Historial reciente del canal (orden cronológico ascendente). */
  async loadRecent(limit = 40): Promise<BiosphereMessage[]> {
    if (!this.supabase) return [];
    try {
      const { data, error } = await this.supabase
        .from("biosphere_messages")
        .select("*")
        .eq("biosphere_id", this.opts.biosphereId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error || !data) return [];
      return (data as BiosphereMessage[]).slice().reverse();
    } catch {
      return [];
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.netRetryTimer) clearTimeout(this.netRetryTimer);
    if (this.gameRetryTimer) clearTimeout(this.gameRetryTimer);
    if (this.sessionRetryTimer) clearTimeout(this.sessionRetryTimer);
    this.teardownVisibilityRetry();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const off of this.netUnsubs) {
      try {
        off();
      } catch {
        /* noop */
      }
    }
    this.netUnsubs = [];
    // Retira todos los remotos que teníamos pintados.
    const net = this.net();
    for (const id of this.lastSeen.keys()) net?.removeRemote(id);
    this.lastSeen.clear();
    if (this.channel && this.supabase) {
      void this.supabase.removeChannel(this.channel);
    }
    this.channel = null;
  }
}
