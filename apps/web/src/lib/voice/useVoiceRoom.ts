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
 * Ciclo de vida:
 *   · join()  → getUserMedia({audio}) MUTEADO, entra al canal de señalización,
 *               ofrece a quienes ya estaban (anti-glare), contesta a los nuevos.
 *   · tracks remotos → <audio> ocultos en el DOM.
 *   · hablando → AnalyserNode por RMS (micro propio + remotos) sobre un umbral.
 *   · leave()/desmontar → cierra TODAS las peer connections, para el micro,
 *               sale del canal.
 *
 * Gating: sólo abre el canal si `enabled` (hay sesión). Sin sesión, join() no hace
 * nada — anónimo sin sesión no dispara conexiones. La identidad la inyecta el
 * padre (misma semántica que el chat: sessionId de Supabase).
 *
 * No requiere credenciales nuevas: reutiliza el cliente Supabase del chat.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { isSupabaseConfigured } from "@/lib/realtime";
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
  /** ¿Tu micrófono está silenciado? (entras MUTEADO por defecto). */
  muted: boolean;
  toggleMute(): void;
  /** Roster de la voz con indicador de quién habla. */
  participants: VoiceParticipant[];
  connectionState: VoiceConnectionState;
}

export interface UseVoiceRoomParams {
  biosphereId: string;
  /** Identidad estable (sessionId de Supabase; misma que usa el chat). */
  identity: string;
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
  audioEl: HTMLAudioElement | null;
  analyser: AnalyserNode | null;
  /** Candidatos ICE llegados antes de fijar la remoteDescription. */
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
}

interface LocalMeter {
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

  const mountedRef = useRef(true);
  const signalingRef = useRef<VoiceSignaling | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const rosterRef = useRef<VoicePresenceMember[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const localMeterRef = useRef<LocalMeter | null>(null);
  const speakingRef = useRef<Map<string, number>>(new Map()); // identity → last-loud ts
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mutedRef = useRef(true);

  // --- Recalcular la lista de participantes (roster + hablando) --------------
  const refreshParticipants = useCallback(() => {
    if (!mountedRef.current) return;
    const now = Date.now();
    const speakingMap = speakingRef.current;
    const isSpeaking = (id: string) => now - (speakingMap.get(id) ?? 0) < SPEAKING_HANG_MS;
    const roster = rosterRef.current;
    // Garantiza que YO figuro aunque el sync de presence aún no me refleje.
    const hasSelf = roster.some((m) => m.identity === identity);
    const base = hasSelf ? roster : [{ identity, name: displayName }, ...roster];
    setParticipants(
      base.map((m) => ({
        identity: m.identity,
        name: m.name,
        isLocal: m.identity === identity,
        speaking: isSpeaking(m.identity),
      }))
    );
  }, [identity, displayName]);

  // --- Estado agregado de conexión de la malla -------------------------------
  const refreshConnectionState = useCallback(() => {
    if (!mountedRef.current) return;
    const peers = peersRef.current;
    if (peers.size === 0) {
      setConnectionState("connected"); // en el canal, sin pares aún: todo ok.
      return;
    }
    let anyConnecting = false;
    let anyFailed = false;
    for (const { pc } of peers.values()) {
      const s = pc.connectionState;
      if (s === "connected") continue;
      if (s === "failed") anyFailed = true;
      else anyConnecting = true;
    }
    setConnectionState(anyFailed && !anyConnecting ? "error" : anyConnecting ? "connecting" : "connected");
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
    const entry: PeerEntry = { pc, audioEl: null, analyser: null, pendingIce: [], remoteSet: false };
    peersRef.current.set(peerId, entry);

    // Publica mi audio hacia este par.
    const stream = localStreamRef.current;
    if (stream) for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        signalingRef.current?.send(iceMessage(identity, peerId, ev.candidate.toJSON()));
      }
    };
    pc.ontrack = (ev) => {
      const [stream0] = ev.streams;
      if (stream0) attachRemoteStream(peerId, stream0);
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

  // --- Limpieza total (leave / desmontar) ------------------------------------
  const teardown = useCallback(() => {
    if (meterTimerRef.current) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
    for (const id of Array.from(peersRef.current.keys())) closePeer(id);
    signalingRef.current?.leave();
    signalingRef.current = null;
    const stream = localStreamRef.current;
    if (stream) for (const t of stream.getTracks()) t.stop();
    localStreamRef.current = null;
    localMeterRef.current = null;
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
    }
  }, [closePeer]);

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
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    setConnectionState("connecting");
    try {
      // 1) Micro (entramos MUTEADOS: deshabilita las pistas de salida).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mountedRef.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      localStreamRef.current = stream;
      mutedRef.current = true;
      setMuted(true);
      for (const t of stream.getAudioTracks()) t.enabled = false; // muteado.

      // 2) AudioContext + medidor del micro propio.
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        audioCtxRef.current = ctx;
        try {
          const src = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          localMeterRef.current = { analyser };
        } catch {
          /* medición best-effort */
        }
      }

      // 3) Señalización Supabase + malla.
      const signaling = new VoiceSignaling(
        getSupabaseBrowserClient(),
        biosphereId,
        { identity, name: displayName },
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
            if (s === "error") setConnectionState("error");
          },
        }
      );
      signalingRef.current = signaling;
      signaling.join();

      startMeter();
      setJoined(true);
      setConnectionState("connected");
      refreshParticipants();
    } catch (err) {
      // Permiso denegado u otro fallo: limpia y marca error.
      const stream = localStreamRef.current;
      if (stream) for (const t of stream.getTracks()) t.stop();
      localStreamRef.current = null;
      signalingRef.current?.leave();
      signalingRef.current = null;
      if (mountedRef.current) {
        setConnectionState("error");
        setJoined(false);
      }
      void err;
    }
  }, [
    enabled,
    biosphereId,
    identity,
    displayName,
    makeOffer,
    handleSignal,
    closePeer,
    refreshParticipants,
    startMeter,
  ]);

  const leave = useCallback(() => {
    teardown();
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    for (const t of stream.getAudioTracks()) t.enabled = !next; // enabled = NO muteado.
    setMuted(next);
    if (next) {
      // Al mutear, deja de figurar como "hablando" de inmediato.
      speakingRef.current.delete(identity);
      refreshParticipants();
    }
  }, [identity, refreshParticipants]);

  // Limpieza al desmontar.
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
  };
}
