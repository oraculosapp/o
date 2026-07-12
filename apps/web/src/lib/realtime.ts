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
  SupabaseClient,
} from "@supabase/supabase-js";
import { ensureAnonSession, getSupabaseBrowserClient } from "./supabase";
import { getStoredArchetypeUrl, getStoredPrimaryTint } from "./avatar-store";

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
      /** URL del GLB del arquetipo del remoto (si eligió uno). */
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
  onZoneSignal(cb: (signal: "far" | "mid" | "near" | "found") => void): () => void;
}

// --- Tipos de dominio --------------------------------------------------------
export interface BiosphereMessage {
  id: string;
  biosphere_id: string;
  user_id: string | null;
  display_name: string;
  content: string;
  is_oracle: boolean;
  created_at: string;
}

export interface RosterMember {
  id: string;
  display_name: string;
  tint?: string;
  archetype?: string;
}

export type RealtimeStatus = "idle" | "connecting" | "live" | "error";

export interface RealtimeIdentity {
  /** id de sesión (uid de Supabase, anónimo o registrado). */
  sessionId: string;
  displayName: string;
  tint: string;
  /** URL del GLB del arquetipo elegido (si hay), para que los demás te vean así. */
  archetype?: string;
  /** true si la sesión es de un usuario registrado (no anónimo). */
  registered: boolean;
  accessToken: string | null;
}

export interface RealtimeCallbacks {
  onRoster?(members: RosterMember[]): void;
  onMessage?(msg: BiosphereMessage): void;
  onStatus?(status: RealtimeStatus): void;
}

export interface BiosphereRealtimeOptions extends RealtimeCallbacks {
  biosphereId: string;
  /** Getter perezoso del world.net del engine (puede no existir todavía). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
  displayName: string;
  tint: string;
}

const POS_HZ = 10;
const REMOTE_TIMEOUT_MS = 5_000;
const SWEEP_MS = 1_000;
const NET_RETRY_MS = 600;
const NET_RETRY_MAX = 20; // ~12 s intentando enganchar world.net

/** ¿Están las env vars públicas de Supabase presentes? (decide si hay chat). */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
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

export class BiosphereRealtime {
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private identity: RealtimeIdentity | null = null;

  private readonly lastSeen = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private netRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private netUnsubs: Array<() => void> = [];
  private netWired = false;
  private disposed = false;

  constructor(private readonly opts: BiosphereRealtimeOptions) {}

  getIdentity(): RealtimeIdentity | null {
    return this.identity;
  }

  /** Arranca sesión + canal. Idempotente: reconectar tras dispose crea uno nuevo. */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.opts.onStatus?.("connecting");
    try {
      const session = await ensureAnonSession();
      if (this.disposed) return;
      this.supabase = getSupabaseBrowserClient();
      const user = session.user;
      this.identity = {
        sessionId: user.id,
        displayName: this.opts.displayName,
        // El color/arquetipo del avatar elegido manda sobre el tinte por defecto.
        tint: getStoredPrimaryTint() ?? this.opts.tint,
        archetype: getStoredArchetypeUrl(),
        registered: user.is_anonymous !== true,
        accessToken: session.access_token ?? null,
      };
      this.subscribe();
    } catch (err) {
      console.warn("[realtime] no se pudo iniciar sesión/canal:", err);
      this.opts.onStatus?.("error");
    }
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
      for (const key of Object.keys(state)) {
        const meta = state[key][0];
        if (!meta) continue;
        members.push({
          id: meta.id ?? key,
          display_name: meta.display_name ?? "Viajero",
          tint: meta.tint,
          archetype: meta.archetype,
        });
      }
      this.opts.onRoster?.(members);
    });

    // (b) Broadcast "pos" — avatares remotos
    channel.on("broadcast", { event: "pos" }, ({ payload }: { payload: PosPayload }) => {
      if (!payload || payload.id === me.sessionId) return;
      const net = this.net();
      this.lastSeen.set(payload.id, Date.now());
      net?.upsertRemote(payload.id, {
        pos: payload.pos,
        yaw: payload.yaw,
        anim: payload.anim,
        tint: payload.tint,
        name: payload.name,
        archetype: payload.archetype,
      });
    });

    // (c) Broadcast "ball" — autoridad = último que la tocó (el emisor)
    channel.on("broadcast", { event: "ball" }, ({ payload }: { payload: BallPayload }) => {
      if (!payload || payload.by === me.sessionId) return;
      this.net()?.applyBallState(payload.ballId, { pos: payload.pos, vel: payload.vel });
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
          archetype: getStoredArchetypeUrl() ?? me.archetype,
        } satisfies PosPayload,
      });
    }, POS_HZ);

    // Reenvía cada patada al balón (autoridad local).
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

    this.netUnsubs.push(stopTick, stopKick);
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
