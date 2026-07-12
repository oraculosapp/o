/**
 * Señalización WebRTC sobre Supabase Realtime para el chat de VOZ de una Biósfera.
 *
 * Arquitectura (fiel al proyecto hermano "Gulu"): MALLA P2P. No hay servidor de
 * medios ni proveedor externo — cada par abre una `RTCPeerConnection` directa con
 * cada otro par. Supabase Realtime actúa SÓLO como canal de señalización, sobre un
 * único channel `voz:<biosphereId>` que combina:
 *
 *   · broadcast "signal" — offers / answers / candidatos ICE, dirigidos (`to`).
 *   · presence           — quién está en la voz (roster + contador) y su nombre.
 *
 * Este módulo aísla el "cableado" del canal para que `useVoiceRoom` se ocupe sólo
 * de la malla WebRTC. Las funciones PURAS (nombre de canal, diffing de presencia,
 * regla anti-glare, constructores de mensaje) viven aquí y se testean sin DOM ni
 * red — el resto (la clase `VoiceSignaling`) envuelve el channel de Supabase.
 *
 * No requiere credenciales nuevas: reutiliza el cliente Supabase del chat (misma
 * anon-key / sesión). Sin sesión, la capa superior no lo instancia (gating).
 */
import type {
  RealtimeChannel,
  RealtimePresenceState,
  SupabaseClient,
} from "@supabase/supabase-js";

/** Prefijo del canal de señalización de voz. `voz:<biosphereId>`. */
export const VOICE_CHANNEL_PREFIX = "voz:";

/** Nombre canónico del canal de voz de una Biósfera. */
export function voiceChannelName(biosphereId: string): string {
  return `${VOICE_CHANNEL_PREFIX}${biosphereId}`;
}

/** Tipo de mensaje de señalización que viaja por broadcast. */
export type SignalKind = "offer" | "answer" | "ice";

/**
 * Sobre de señalización DIRIGIDO. Todos los pares reciben el broadcast (Supabase no
 * enruta por destinatario), así que cada receptor descarta los que no van para él
 * comparando `to` con su propia identidad.
 */
export interface SignalMessage {
  kind: SignalKind;
  /** Identidad del emisor. */
  from: string;
  /** Identidad del destinatario. */
  to: string;
  /**
   * Carga útil: `RTCSessionDescriptionInit` para offer/answer, `RTCIceCandidateInit`
   * para ice. Se tipa laxo aquí para no acoplar el módulo a los tipos DOM (este
   * archivo también lo consumen los tests en entorno node).
   */
  payload: unknown;
}

/** Metadatos de presencia que publica cada participante de la voz. */
export interface VoicePresenceMeta {
  identity: string;
  name: string;
}

/** Participante visto en el roster de presencia. */
export interface VoicePresenceMember {
  identity: string;
  name: string;
}

// --- Helpers PUROS (testeables sin DOM ni Supabase) --------------------------

type PresenceState = RealtimePresenceState<VoicePresenceMeta>;

/**
 * Extrae el roster (identidad + nombre) de un estado de presence de Supabase.
 * La clave del canal de presence es la propia identidad; usamos el primer meta.
 */
export function membersFromPresence(state: PresenceState): VoicePresenceMember[] {
  const out: VoicePresenceMember[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(state)) {
    const meta = state[key]?.[0];
    const identity = meta?.identity ?? key;
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    out.push({ identity, name: meta?.name?.trim() || identity });
  }
  return out;
}

/** Identidades de los OTROS pares presentes (excluye la propia). */
export function peerIdsFromPresence(state: PresenceState, myId: string): string[] {
  return membersFromPresence(state)
    .map((m) => m.identity)
    .filter((id) => id !== myId);
}

/**
 * REGLA ANTI-GLARE (fiel a Gulu): "quien LLEGA ofrece; quien YA estaba contesta".
 *
 * Cuando entro en el canal, los pares que ya figuran en la presencia estaban ANTES
 * que yo: yo soy el recién llegado, así que YO les mando la offer a ellos. A los
 * pares que entren DESPUÉS (evento presence "join") no les ofrezco: ellos serán los
 * recién llegados y me ofrecerán a mí. Así, por cada pareja, exactamente un extremo
 * inicia la negociación y nunca colisionan dos offers.
 *
 * @param peerWasPresentWhenIJoined  true si el par ya estaba al suscribirme.
 */
export function iInitiateOffer(peerWasPresentWhenIJoined: boolean): boolean {
  return peerWasPresentWhenIJoined;
}

/** Diferencia dos rosters de identidades → { entrantes, salientes }. */
export function diffPeers(
  prev: Iterable<string>,
  next: Iterable<string>
): { joined: string[]; left: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const joined: string[] = [];
  const left: string[] = [];
  for (const id of nextSet) if (!prevSet.has(id)) joined.push(id);
  for (const id of prevSet) if (!nextSet.has(id)) left.push(id);
  return { joined, left };
}

/** Constructores de mensaje (garantizan la forma del sobre). */
export function offerMessage(from: string, to: string, sdp: unknown): SignalMessage {
  return { kind: "offer", from, to, payload: sdp };
}
export function answerMessage(from: string, to: string, sdp: unknown): SignalMessage {
  return { kind: "answer", from, to, payload: sdp };
}
export function iceMessage(from: string, to: string, candidate: unknown): SignalMessage {
  return { kind: "ice", from, to, payload: candidate };
}

// --- Cableado del canal (envuelve Supabase Realtime) -------------------------

export interface VoiceSignalingHandlers {
  /**
   * Se llama UNA vez, tras el primer sync de presencia, con los pares que ya
   * estaban en el canal cuando entré (a ellos les ofrezco — regla anti-glare).
   */
  onReady(initialPeers: string[]): void;
  /** Un par nuevo entró DESPUÉS que yo (él me ofrecerá; yo sólo contesto). */
  onPeerJoin(peerId: string): void;
  /** Un par salió del canal (cierra su RTCPeerConnection). */
  onPeerLeave(peerId: string): void;
  /** Llegó un mensaje de señalización dirigido a mí. */
  onSignal(msg: SignalMessage): void;
  /** Roster completo (para pintar la lista de participantes + contador). */
  onRoster(members: VoicePresenceMember[]): void;
  /** Cambios de estado de la suscripción del canal. */
  onStatus?(status: "connecting" | "live" | "error"): void;
}

const SIGNAL_EVENT = "signal";

/**
 * Envoltorio del channel de señalización de voz. Idempotente: `leave()` desmonta.
 * Reutiliza el cliente Supabase existente (no abre credenciales nuevas).
 */
export class VoiceSignaling {
  private channel: RealtimeChannel | null = null;
  private ready = false;
  private known = new Set<string>();
  private disposed = false;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly biosphereId: string,
    private readonly me: VoicePresenceMeta,
    private readonly handlers: VoiceSignalingHandlers
  ) {}

  /** Suscribe al canal, publica mi presencia y arranca la escucha de señales. */
  join(): void {
    if (this.channel || this.disposed) return;
    this.handlers.onStatus?.("connecting");

    const channel = this.supabase.channel(voiceChannelName(this.biosphereId), {
      config: {
        // La clave de presence es mi identidad (autoritativa para el enrutado).
        presence: { key: this.me.identity },
        broadcast: { self: false },
      },
    });

    // Señales dirigidas: descarto las que no van para mí.
    channel.on("broadcast", { event: SIGNAL_EVENT }, ({ payload }: { payload: SignalMessage }) => {
      if (!payload || payload.to !== this.me.identity) return;
      if (payload.from === this.me.identity) return;
      this.handlers.onSignal(payload);
    });

    // Presencia: primer sync → pares que ya estaban (les ofrezco). Syncs
    // posteriores → detecto entrantes/salientes por diff y refresco el roster.
    channel.on("presence", { event: "sync" }, () => {
      if (this.disposed) return;
      const state = channel.presenceState() as PresenceState;
      const members = membersFromPresence(state);
      this.handlers.onRoster(members);

      const peers = members.map((m) => m.identity).filter((id) => id !== this.me.identity);
      if (!this.ready) {
        this.ready = true;
        this.known = new Set(peers);
        this.handlers.onReady(peers);
        return;
      }
      const { joined, left } = diffPeers(this.known, peers);
      this.known = new Set(peers);
      for (const id of joined) this.handlers.onPeerJoin(id);
      for (const id of left) this.handlers.onPeerLeave(id);
    });

    channel.subscribe((status) => {
      if (this.disposed) return;
      if (status === "SUBSCRIBED") {
        this.handlers.onStatus?.("live");
        void channel.track({ identity: this.me.identity, name: this.me.name });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        this.handlers.onStatus?.("error");
      }
    });

    this.channel = channel;
  }

  /** Envía un sobre de señalización por broadcast (lo recibe todo el canal). */
  send(msg: SignalMessage): void {
    if (!this.channel || this.disposed) return;
    void this.channel.send({ type: "broadcast", event: SIGNAL_EVENT, payload: msg });
  }

  /** Actualiza mi nombre visible en la presencia sin reconectar. */
  async setName(name: string): Promise<void> {
    this.me.name = name;
    if (this.channel) await this.channel.track({ identity: this.me.identity, name });
  }

  /** Sale del canal y libera la suscripción. Idempotente. */
  leave(): void {
    this.disposed = true;
    if (this.channel) {
      void this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.known.clear();
  }
}
