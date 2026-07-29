"use client";

/**
 * Hook de cliente para el chat de VOZ de una Biósfera — MALLA WebRTC P2P.
 *
 * Arquitectura (fiel a "Gulu"): sin proveedor externo ni servidor de medios. Cada
 * participante abre una `RTCPeerConnection` NATIVA con cada otro (malla completa).
 * La señalización viaja por Supabase Realtime (`lib/voice/signaling.ts`, canal
 * `voz:<biosphereId>`). ICE por STUN de Google; SIN TURN (limitación v1: en redes
 * muy restrictivas —CGNAT/simétricas— un par podría no oír a otro).
 *
 * Ciclo de vida del CANAL:
 *   · join()  → verifica contexto seguro y permiso (Permissions API, SIN abrir el
 *               micro), entra al canal de señalización, ofrece a quienes ya estaban
 *               (anti-glare) y contesta a los nuevos. Se entra MUTEADO.
 *   · tracks remotos → <audio> ocultos en el DOM.
 *   · hablando → AnalyserNode por RMS (micro propio + remotos) sobre un umbral.
 *   · leave()/desmontar → cierra TODAS las peer connections, suelta el micro,
 *               sale del canal.
 *
 * Ciclo de vida del MICRÓFONO (invariante: el micro está ABIERTO si y sólo si estás
 * DESMUTEADO). Antes se abría en join() y se quedaba abierto hasta "Salir",
 * silenciando sólo con `track.enabled=false`: el indicador de captura del navegador
 * seguía encendido todo el rato y, en Bluetooth, el SO mantenía el auricular en
 * ruta de llamada (HFP), degradando TODO el audio del juego. Ahora:
 *   · join()          → NO llama a getUserMedia (entras muteado: no hay nada que
 *                       capturar). El permiso se pre-chequea con la Permissions API.
 *   · 1er desmuteo    → getUserMedia(MIC_CONSTRAINTS) — es un gesto del usuario, así
 *                       que el prompt del navegador sale aquí, cuando de verdad hace
 *                       falta. La pista se inyecta en cada par con
 *                       `RTCRtpSender.replaceTrack` → SIN renegociación (cada par
 *                       nace con un transceptor de audio "carril" ya negociado).
 *   · mutear          → silencio INMEDIATO (`enabled=false`) y, tras
 *                       MIC_RELEASE_GRACE_MS, `track.stop()` + `replaceTrack(null)`:
 *                       el micro se cierra de verdad. Si te desmuteas dentro de la
 *                       gracia, se reactiva sin re-adquirir (ver lib/voice/mic.ts).
 *   · fallo al re-adquirir (p. ej. permiso revocado entre medias) → vuelves a
 *                       MUTEADO y `errorReason` toma la categoría de errors.ts. No
 *                       te echa del canal: sigues OYENDO a los demás.
 *
 * Gating: sólo abre el canal si `enabled` (hay sesión). Sin sesión, join() no hace
 * nada — anónimo sin sesión no dispara conexiones. La identidad la inyecta el
 * padre (misma semántica que el chat: sessionId de Supabase).
 *
 * Ciclo de vida del CANAL vs. el NOMBRE visible: el canal (join/teardown) sólo se
 * desmonta por cambios en `biosphereId`, `identity` o `enabled` — nunca por
 * `displayName`. El nombre es editable en caliente (el chat lo deja renombrarse) y
 * viaja por un efecto SEPARADO que llama a `VoiceSignaling.setName()` (sólo
 * `channel.track`, sin reabrir el canal ni recrear peer connections). Un
 * `displayNameRef` guarda el nombre vigente para que `join()` y cualquier
 * reconexión posterior usen SIEMPRE el nombre actual, no una clausura vieja.
 *
 * No requiere credenciales nuevas: reutiliza el cliente Supabase del chat.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { isSupabaseConfigured } from "@/lib/realtime";
import { classifyGetUserMediaError, type VoiceErrorReason } from "./errors";
import {
  MIC_CONSTRAINTS,
  MIC_RELEASE_GRACE_MS,
  isMicErrorReason,
  replaceTrackOnSenders,
  stopMicStream,
} from "./mic";
import {
  VoiceSignaling,
  answerMessage,
  iceMessage,
  iInitiateOffer,
  offerMessage,
  type SignalMessage,
  type VoicePresenceMember,
} from "./signaling";

/** Estado agregado de la malla, para pintar un hint de conexión. */
export type VoiceConnectionState = "idle" | "connecting" | "connected" | "error";

export type { VoiceErrorReason } from "./errors";

export interface VoiceParticipant {
  identity: string;
  name: string;
  /** true si está hablando ahora (nivel de audio sobre umbral). */
  speaking: boolean;
  /** true si es el participante local (tú). */
  isLocal: boolean;
}

export interface UseVoiceRoom {
  /** ¿Estás dentro del canal de voz? */
  joined: boolean;
  join(): Promise<void>;
  leave(): void;
  /**
   * ¿Tu micrófono está silenciado? Entras MUTEADO por defecto y, mientras lo estés,
   * el micro ni siquiera está abierto (ver "Ciclo de vida del MICRÓFONO" arriba).
   */
  muted: boolean;
  /**
   * Alterna el mute. Muteado→hablando ADQUIERE el micro (la primera vez dispara el
   * prompt del navegador); es asíncrono por dentro pero no hace falta esperarlo: si
   * la adquisición falla, el hook vuelve a `muted=true` y publica el `errorReason`.
   */
  toggleMute(): void;
  /** Roster de la voz con indicador de quién habla. */
  participants: VoiceParticipant[];
  connectionState: VoiceConnectionState;
  /**
   * Motivo del último fallo (o null). Separa el fallo de MICRÓFONO (permission /
   * no-mic / in-use / insecure) del fallo de CONEXIÓN P2P (connection) para que la
   * UI muestre el mensaje correcto en vez de un genérico engañoso.
   */
  errorReason: VoiceErrorReason;
}

export interface UseVoiceRoomParams {
  biosphereId: string;
  /** Identidad estable (sessionId de Supabase; misma que usa el chat). */
  identity: string;
  /**
   * Nombre visible; puede cambiar en caliente (renombrarse en el chat) SIN
   * desmontar el canal — ver "Ciclo de vida del CANAL vs. el NOMBRE visible" arriba.
   */
  displayName: string;
  /** Gating: sólo con sesión (enabled=true) se abre el canal. */
  enabled?: boolean;
}

// ICE: STUN público de Google. Sin TURN (limitación v1 documentada en docs/voz.md).
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const SPEAKING_THRESHOLD = 0.06; // RMS normalizado (0..1); umbral de "hablando".
const SPEAKING_HANG_MS = 350; // histéresis: mantiene "hablando" un instante tras callar.

interface PeerEntry {
  pc: RTCPeerConnection;
  /**
   * Sender del transceptor de audio "carril" hacia este par. Existe desde que se
   * crea la conexión (aunque el micro esté cerrado por estar muteado) para poder
   * meter/sacar la pista con `replaceTrack` SIN renegociar.
   */
  sender: RTCRtpSender | null;
  audioEl: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  /** Candidatos ICE llegados antes de fijar la remoteDescription. */
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
}

/** Medidor del micro propio. Vive sólo mientras el micro está abierto. */
interface LocalMeter {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
}

/** RMS normalizado (0..1) de un AnalyserNode en el dominio del tiempo. */
function rms(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export function useVoiceRoom(params: UseVoiceRoomParams): UseVoiceRoom {
  const { biosphereId, identity, displayName, enabled = false } = params;

  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(true);
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [connectionState, setConnectionState] = useState<VoiceConnectionState>("idle");
  const [errorReason, setErrorReason] = useState<VoiceErrorReason>(null);

  const mountedRef = useRef(true);
  /**
   * Nombre vigente, en ref (no en clausura). Lo lee `refreshParticipants` (para el
   * hueco "aún no reflejado en presencia") y `join()` (para el `track()` inicial y
   * cualquier rejoin posterior) — así ninguno arrastra un `displayName` viejo aunque
   * su callback memoizado sea anterior al último renombrado.
   */
  const displayNameRef = useRef(displayName);
  const signalingRef = useRef<VoiceSignaling | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const rosterRef = useRef<VoicePresenceMember[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localMeterRef = useRef<LocalMeter | null>(null);
  const speakingRef = useRef<Map<string, number>>(new Map()); // identity → last-loud ts
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Intención del usuario (fuente de verdad; el estado `muted` es su espejo). */
  const mutedRef = useRef(true);
  /** Temporizador de gracia mute→soltar el micro (ver MIC_RELEASE_GRACE_MS). */
  const micReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** ¿Hay un getUserMedia en vuelo? Evita adquisiciones solapadas por doble clic. */
  const acquiringRef = useRef(false);

  // --- Recalcular la lista de participantes (roster + hablando) --------------
  // OJO displayName: lee `displayNameRef` (no la prop cerrada) para que esta función
  // NO cambie de identidad al renombrarse — si dependiera de `displayName`, arrastraría
  // ese cambio hasta `closePeer`/`teardown` y el efecto de desmontaje (dep. `teardown`)
  // se re-ejecutaría, tirando el canal entero en cada tecla del nombre.
  const refreshParticipants = useCallback(() => {
    if (!mountedRef.current) return;
    const now = Date.now();
    const speakingMap = speakingRef.current;
    const isSpeaking = (id: string) => now - (speakingMap.get(id) ?? 0) < SPEAKING_HANG_MS;
    const roster = rosterRef.current;
    // Garantiza que YO figuro aunque el sync de presence aún no me refleje.
    const hasSelf = roster.some((m) => m.identity === identity);
    const base = hasSelf ? roster : [{ identity, name: displayNameRef.current }, ...roster];
    setParticipants(
      base.map((m) => ({
        identity: m.identity,
        name: m.name,
        isLocal: m.identity === identity,
        speaking: isSpeaking(m.identity),
      }))
    );
  }, [identity]);

  // --- Estado agregado de conexión de la malla -------------------------------
  // OJO: un par WebRTC en `failed` (sin TURN / red restrictiva) NO es un problema de
  // micrófono. Si el micro se obtuvo y estamos en el canal, seguimos "connected"; el
  // fallo de un par se anota como aviso SUAVE (errorReason="connection") y NUNCA se
  // pinta como error rojo total ni dispara el mensaje de "revisa el micrófono".
  const refreshConnectionState = useCallback(() => {
    if (!mountedRef.current) return;
    const peers = peersRef.current;
    if (peers.size === 0) {
      setConnectionState("connected"); // en el canal, sin pares aún: todo ok.
      // Si veníamos de un aviso de par fallido y ya no hay pares, límpialo.
      setErrorReason((r) => (r === "connection" ? null : r));
      return;
    }
    let anyConnecting = false;
    let anyFailed = false;
    for (const { pc } of peers.values()) {
      const s = pc.connectionState;
      if (s === "connected") continue;
      if (s === "failed") anyFailed = true;
      else anyConnecting = true; // new / connecting / disconnected: aún negociando.
    }
    if (anyConnecting) {
      setConnectionState("connecting");
      return;
    }
    // Ya no hay pares negociando: todos resolvieron a connected o failed. El micro y
    // el canal están bien → seguimos "connected". Si algún par quedó en `failed`,
    // lo señalamos como aviso suave (no como error de micrófono).
    setConnectionState("connected");
    setErrorReason((r) => (anyFailed ? "connection" : r === "connection" ? null : r));
  }, []);

  // --- Adjuntar/soltar audio remoto ------------------------------------------
  const attachRemoteStream = useCallback(
    (peerId: string, stream: MediaStream) => {
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      if (!entry.audioEl) {
        const el = document.createElement("audio");
        el.autoplay = true;
        el.style.display = "none";
        document.body.appendChild(el);
        entry.audioEl = el;
      }
      entry.audioEl.srcObject = stream;
      void entry.audioEl.play().catch(() => {
        /* autoplay puede requerir gesto; el usuario ya pulsó "Unirse". */
      });
      // Medidor de "hablando" del remoto.
      const ctx = audioCtxRef.current;
      if (ctx && stream.getAudioTracks().length > 0) {
        try {
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          entry.analyser = analyser;
        } catch {
          /* medición best-effort */
        }
      }
    },
    []
  );

  // --- Crear (o recuperar) la RTCPeerConnection con un par -------------------
  const ensurePeer = useCallback((peerId: string): PeerEntry => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = {
      pc,
      sender: null,
      audioEl: null,
      analyser: null,
      pendingIce: [],
      remoteSet: false,
    };
    peersRef.current.set(peerId, entry);

    // CARRIL de audio hacia este par. Creamos SIEMPRE el transceptor sendrecv,
    // tengamos micro abierto o no (lo normal al entrar: muteado y sin micro). Así el
    // m-line de audio existe desde la PRIMERA oferta y luego basta `replaceTrack`
    // para hablar o callar, SIN renegociar. Con `addTrack` al desmutear habría que
    // renegociar (offer/answer nuevos) en cada mute/unmute.
    try {
      const { sender } = pc.addTransceiver("audio", { direction: "sendrecv" });
      entry.sender = sender;
      const track = localStreamRef.current?.getAudioTracks()[0] ?? null;
      if (track) void sender.replaceTrack(track).catch(() => {});
    } catch {
      /* sin transceptor no podré enviar, pero seguiré OYENDO (best-effort) */
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signalingRef.current?.send(iceMessage(identity, peerId, ev.candidate.toJSON()));
      }
    };
    pc.ontrack = (ev) => {
      // OJO: el par pudo negociar su carril SIN pista (entró muteado y su micro ni
      // se abrió). Entonces no hay MSID y `ev.streams` llega VACÍO: envolvemos la
      // pista en un MediaStream propio para reproducirla y medirla igual. Cuando el
      // par desmutee, su `replaceTrack` llena ESTE mismo carril (misma pista, sin
      // renegociar) y empieza a sonar sin tocar nada más.
      const [stream0] = ev.streams;
      attachRemoteStream(peerId, stream0 ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      refreshConnectionState();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // Deja que el barrido de presencia o leave lo limpie; no cierres a ciegas.
      }
    };
    return entry;
  }, [identity, attachRemoteStream, refreshConnectionState]);

  // --- Iniciar una offer hacia un par (yo soy el recién llegado) -------------
  const makeOffer = useCallback(
    async (peerId: string) => {
      const { pc } = ensurePeer(peerId);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signalingRef.current?.send(offerMessage(identity, peerId, offer));
      } catch {
        /* negociación best-effort; el otro extremo puede reintentar */
      }
    },
    [identity, ensurePeer]
  );

  // --- Procesar una señal entrante -------------------------------------------
  const handleSignal = useCallback(
    async (msg: SignalMessage) => {
      const entry = ensurePeer(msg.from);
      const { pc } = entry;
      try {
        if (msg.kind === "offer") {
          await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
          entry.remoteSet = true;
          for (const c of entry.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signalingRef.current?.send(answerMessage(identity, msg.from, answer));
        } else if (msg.kind === "answer") {
          await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
          entry.remoteSet = true;
          for (const c of entry.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        } else if (msg.kind === "ice") {
          const cand = msg.payload as RTCIceCandidateInit;
          if (entry.remoteSet) await pc.addIceCandidate(cand).catch(() => {});
          else entry.pendingIce.push(cand); // aún sin remoteDescription: encola.
        }
      } catch {
        /* señal malformada o fuera de orden: ignora (best-effort) */
      }
    },
    [identity, ensurePeer]
  );

  // --- Cerrar la conexión con un par -----------------------------------------
  const closePeer = useCallback((peerId: string) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    peersRef.current.delete(peerId);
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    } catch {
      /* noop */
    }
    if (entry.audioEl) {
      entry.audioEl.pause();
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    speakingRef.current.delete(peerId);
    refreshConnectionState();
    refreshParticipants();
  }, [refreshConnectionState, refreshParticipants]);

  // --- Micrófono local: medidor, adquisición y liberación --------------------

  /** Senders del carril de audio de cada par (destino de `replaceTrack`). */
  const audioSenders = useCallback((): RTCRtpSender[] => {
    const out: RTCRtpSender[] = [];
    for (const entry of peersRef.current.values()) if (entry.sender) out.push(entry.sender);
    return out;
  }, []);

  /** Engancha el medidor de "hablando" del micro propio al stream recién abierto. */
  const attachLocalMeter = useCallback((stream: MediaStream) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      void ctx.resume().catch(() => {}); // por si el contexto quedó suspendido.
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      localMeterRef.current = { source, analyser };
    } catch {
      /* medición best-effort: sin medidor sigues hablando igual */
    }
  }, []);

  /** Desconecta el medidor del micro (el stream se va: su nodo fuente ya no vale). */
  const disposeLocalMeter = useCallback(() => {
    const meter = localMeterRef.current;
    localMeterRef.current = null;
    if (!meter) return;
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      /* nodo ya suelto */
    }
  }, []);

  /**
   * Suelta el micro DE VERDAD: lo retira de la malla (`replaceTrack(null)`, sin
   * renegociar) y para las pistas. Aquí es donde se apaga el indicador de captura
   * del navegador y el SO puede devolver el Bluetooth a perfil de música (A2DP).
   */
  const releaseLocalMic = useCallback(() => {
    if (micReleaseTimerRef.current) {
      clearTimeout(micReleaseTimerRef.current);
      micReleaseTimerRef.current = null;
    }
    const stream = localStreamRef.current;
    localStreamRef.current = null;
    disposeLocalMeter();
    // Vacía el carril ANTES de parar la pista: el par deja de recibir sin sobresaltos.
    void replaceTrackOnSenders(audioSenders(), null);
    stopMicStream(stream);
  }, [audioSenders, disposeLocalMeter]);

  /**
   * Programa la liberación del micro tras la gracia. Si dentro de la ventana te
   * vuelves a desmutear, el temporizador se cancela y no se re-adquiere nada.
   */
  const scheduleMicRelease = useCallback(() => {
    if (!localStreamRef.current || micReleaseTimerRef.current) return;
    micReleaseTimerRef.current = setTimeout(() => {
      micReleaseTimerRef.current = null;
      if (!mutedRef.current) return; // te desmuteaste dentro de la gracia: consérvalo.
      releaseLocalMic();
    }, MIC_RELEASE_GRACE_MS);
  }, [releaseLocalMic]);

  // --- Limpieza total (leave / desmontar) ------------------------------------
  const teardown = useCallback(() => {
    if (meterTimerRef.current) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    for (const id of Array.from(peersRef.current.keys())) closePeer(id);
    signalingRef.current?.leave();
    signalingRef.current = null;
    // Sin pares ya: `releaseLocalMic` sólo para el micro y desmonta su medidor.
    acquiringRef.current = false;
    releaseLocalMic();
    speakingRef.current.clear();
    rosterRef.current = [];
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (mountedRef.current) {
      setJoined(false);
      setMuted(true);
      mutedRef.current = true;
      setParticipants([]);
      setConnectionState("idle");
      setErrorReason(null);
    }
  }, [closePeer, releaseLocalMic]);

  // --- Bucle de medición de "hablando" ---------------------------------------
  const startMeter = useCallback(() => {
    if (meterTimerRef.current) return;
    meterTimerRef.current = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const mark = (id: string) => {
        speakingRef.current.set(id, now);
        changed = true;
      };
      // Micro propio (sólo si NO estoy muteado).
      const lm = localMeterRef.current;
      if (lm && !mutedRef.current && rms(lm.analyser) > SPEAKING_THRESHOLD) mark(identity);
      // Remotos.
      for (const [peerId, entry] of peersRef.current) {
        if (!entry.analyser) continue;
        if (rms(entry.analyser) > SPEAKING_THRESHOLD) mark(peerId);
      }
      // Refresca si alguien acaba de hablar o si algún "hablando" ya expiró.
      if (changed) refreshParticipants();
      else {
        for (const ts of speakingRef.current.values()) {
          if (now - ts < SPEAKING_HANG_MS + 200) {
            refreshParticipants();
            break;
          }
        }
      }
    }, 200);
  }, [identity, refreshParticipants]);

  // --- join ------------------------------------------------------------------
  const join = useCallback(async () => {
    if (!enabled || signalingRef.current || !isSupabaseConfigured()) return;

    // 0) Contexto seguro + API disponible. getUserMedia sólo existe en HTTPS (o
    // localhost); si falta, no tiene sentido intentar: mensaje "necesita HTTPS".
    const insecure =
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      (typeof window !== "undefined" && window.isSecureContext === false);
    if (insecure) {
      if (mountedRef.current) {
        setConnectionState("error");
        setErrorReason("insecure");
      }
      return;
    }

    setErrorReason(null); // limpia el error del intento anterior (reintento).
    setConnectionState("connecting");

    // 0.5) Pre-chequeo del permiso (best-effort; no todos los navegadores soportan
    // el nombre "microphone" en la Permissions API). Es el ÚNICO chequeo de micro
    // del join —aquí ya no se abre el dispositivo—, y sirve para no meterte en un
    // canal donde nunca podrás hablar: si está DENEGADO de forma persistente, corta
    // ya y dirige al candado 🔒 en vez de dejarte descubrirlo al primer desmuteo.
    try {
      const permissions = navigator.permissions;
      if (permissions?.query) {
        const status = await permissions.query({
          name: "microphone",
        } as unknown as PermissionDescriptor);
        if (status.state === "denied") {
          if (mountedRef.current) {
            setConnectionState("error");
            setErrorReason("permission");
          }
          return;
        }
      }
    } catch {
      /* Permissions API sin soporte para "microphone": seguimos a getUserMedia. */
    }

    if (!mountedRef.current) return;

    // 1) NO abrimos el micrófono aquí: al canal se entra MUTEADO, y un micro abierto
    // que no captura nada es sólo un indicador de captura encendido (y, en
    // Bluetooth, el auricular clavado en perfil de llamada). El `getUserMedia` real
    // ocurre en el PRIMER desmuteo —que también es un gesto del usuario, así que el
    // prompt del navegador sigue siendo válido— y sus fallos se categorizan allí con
    // el mismo `classifyGetUserMediaError`.
    mutedRef.current = true;
    setMuted(true);

    // Desde aquí, cualquier fallo es de señalización/negociación (red/servidor), NO
    // de micrófono → "connection".
    try {
      // 2) AudioContext para los medidores de "hablando". Se crea ya (estamos en un
      // gesto del usuario, así que arranca "running"): los remotos se enganchan al
      // llegar cada pista y el del micro propio, cuando se adquiera al desmutear.
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) audioCtxRef.current = new AC();

      // 3) Señalización Supabase + malla. Nombre vigente vía ref (no la clausura de
      // `displayName`): si join() corre desde un callback memoizado antes del último
      // renombrado, igual entra con el nombre correcto.
      const signaling = new VoiceSignaling(
        getSupabaseBrowserClient(),
        biosphereId,
        { identity, name: displayNameRef.current },
        {
          onReady: (initialPeers) => {
            // Anti-glare: yo llegué, ofrezco a quienes YA estaban.
            for (const peerId of initialPeers) {
              if (iInitiateOffer(true)) void makeOffer(peerId);
            }
          },
          onPeerJoin: () => {
            // Nuevo par: él me ofrecerá (yo contesto). No inicio offer.
          },
          onPeerLeave: (peerId) => closePeer(peerId),
          onSignal: (msg) => void handleSignal(msg),
          onRoster: (members) => {
            rosterRef.current = members;
            refreshParticipants();
          },
          onStatus: (s) => {
            if (!mountedRef.current) return;
            // Fallo del CANAL de señalización (Supabase caído/timeout): no es el
            // micrófono → categoría "connection".
            if (s === "error") {
              setConnectionState("error");
              setErrorReason("connection");
            }
          },
        }
      );
      signalingRef.current = signaling;
      signaling.join();

      startMeter();
      setJoined(true);
      setConnectionState("connected");
      setErrorReason(null);
      refreshParticipants();
    } catch (err) {
      // Fallo de señalización/negociación (el micro ni se tocó todavía).
      console.warn("[voz]", err);
      signalingRef.current?.leave();
      signalingRef.current = null;
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      if (mountedRef.current) {
        setConnectionState("error");
        setErrorReason("connection");
        setJoined(false);
      }
    }
  }, [
    enabled,
    biosphereId,
    identity,
    makeOffer,
    handleSignal,
    closePeer,
    refreshParticipants,
    startMeter,
  ]);

  const leave = useCallback(() => {
    teardown();
  }, [teardown]);

  /**
   * DESMUTEAR. Dos caminos:
   *   · El micro sigue vivo (mute reciente, dentro de la gracia) → basta reactivar
   *     las pistas: instantáneo y sin re-adquirir el dispositivo.
   *   · No hay micro (primer desmuteo o gracia vencida) → `getUserMedia` con las
   *     constraints explícitas y `replaceTrack` en cada par, SIN renegociar.
   *
   * Si la adquisición falla (permiso revocado mientras tanto, micro robado por otra
   * app, dispositivo desconectado) NO te echa del canal: vuelves a MUTEADO —sigues
   * oyendo a los demás— y `errorReason` toma la categoría de `errors.ts`, que la UI
   * pinta como error duro de micrófono.
   */
  const unmute = useCallback(async () => {
    // Cancela una liberación pendiente: sigues queriendo el micro.
    if (micReleaseTimerRef.current) {
      clearTimeout(micReleaseTimerRef.current);
      micReleaseTimerRef.current = null;
    }
    const alive = localStreamRef.current;
    if (alive) {
      for (const t of alive.getAudioTracks()) t.enabled = true;
      return;
    }
    // Una sola adquisición en vuelo: si haces doble clic, la que ya corre honrará la
    // intención FINAL (`mutedRef`) al terminar.
    if (acquiringRef.current) return;

    const usable =
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";
    if (!usable) {
      mutedRef.current = true;
      setMuted(true);
      setErrorReason("insecure");
      return;
    }

    acquiringRef.current = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      console.warn("[voz]", err);
      acquiringRef.current = false;
      if (mountedRef.current) {
        mutedRef.current = true;
        setMuted(true); // vuelta a muteado: no te quedas "hablando" sin micro.
        setErrorReason(classifyGetUserMediaError(err));
      }
      return;
    }
    acquiringRef.current = false;

    // ¿Sigo dentro y sigo queriendo hablar? Si saliste (o volviste a mutear) durante
    // el prompt, tira el stream recién abierto: el micro no se queda encendido.
    if (!mountedRef.current || !signalingRef.current || mutedRef.current) {
      stopMicStream(stream);
      return;
    }

    localStreamRef.current = stream;
    for (const t of stream.getAudioTracks()) t.enabled = true;
    attachLocalMeter(stream);
    // Inyecta la pista en el carril ya negociado de cada par: sin offer/answer.
    await replaceTrackOnSenders(audioSenders(), stream.getAudioTracks()[0] ?? null);
    // Limpia SÓLO un error de MICRO anterior; un aviso de conexión sigue vigente.
    if (mountedRef.current) setErrorReason((r) => (isMicErrorReason(r) ? null : r));
  }, [attachLocalMeter, audioSenders]);

  const toggleMute = useCallback(() => {
    if (!signalingRef.current) return; // fuera del canal no hay nada que alternar.
    const next = !mutedRef.current;
    mutedRef.current = next; // intención del usuario: fuente de verdad.
    setMuted(next);
    if (next) {
      // MUTEAR: silencio INMEDIATO; la liberación física va tras la gracia.
      const stream = localStreamRef.current;
      if (stream) for (const t of stream.getAudioTracks()) t.enabled = false;
      // Deja de figurar como "hablando" de inmediato.
      speakingRef.current.delete(identity);
      refreshParticipants();
      scheduleMicRelease();
      return;
    }
    void unmute();
  }, [identity, refreshParticipants, scheduleMicRelease, unmute]);

  /**
   * RENOMBRARSE EN CALIENTE: efecto separado del ciclo de vida del canal. Sólo
   * actualiza el ref (para join()/refreshParticipants) y, si ya estoy conectado,
   * empuja el nombre nuevo por `VoiceSignaling.setName()` (un `channel.track`, sin
   * reabrir el canal ni recrear peer connections). El roster lo refleja cuando
   * llegue el siguiente sync de presencia — el mismo camino que ya usan los demás
   * pares al entrar/salir — así que no hace falta tocar `rosterRef` a mano aquí.
   */
  useEffect(() => {
    displayNameRef.current = displayName;
    if (signalingRef.current) void signalingRef.current.setName(displayName);
  }, [displayName]);

  // Limpieza al desmontar. OJO: depende SÓLO de `teardown`, que a su vez cuelga de
  // `closePeer`/`releaseLocalMic` — ninguno de los dos depende ya de `displayName`
  // (ver nota en `refreshParticipants`). El canal, por tanto, sólo se desmonta por
  // cambios reales de ciclo de vida (identity/enabled o desmontaje del componente),
  // nunca por un renombrado.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  // Si el gating se apaga (pierde la sesión) estando dentro, sal con gracia.
  useEffect(() => {
    if (!enabled && signalingRef.current) teardown();
  }, [enabled, teardown]);

  return {
    joined,
    join,
    leave,
    muted,
    toggleMute,
    participants,
    connectionState,
    errorReason,
  };
}
