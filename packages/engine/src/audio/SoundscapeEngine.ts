import { createNoiseBuffer } from "./noise";
import { getAudioMuted, subscribeAudioMuted, setAudioMuted } from "./muteStore";

/** Buffers de ruido compartidos por todas las capas (se crean con el contexto). */
export interface NoiseField {
  pink: AudioBuffer;
  white: AudioBuffer;
}

type WebkitWindow = typeof globalThis & { webkitAudioContext?: typeof AudioContext };

/**
 * MOTOR WebAudio del soundscape. Responsabilidades:
 *
 * 1. **Política de autoplay**: el AudioContext NO se crea hasta el primer gesto
 *    del usuario. Antes de eso, todo es silencio sin errores ni warnings (no hay
 *    contexto que reanudar). {@link unlock} lo crea y reanuda; devuelve `true` la
 *    primera vez.
 * 2. **Cadena maestra**: `master (Gain) → limiter (DynamicsCompressor suave) →
 *    destino`. Las capas se enchufan a {@link master}.
 * 3. **Mute persistido**: lee/observa {@link muteStore} (localStorage). El mute
 *    hace rampa del gain maestro a 0 sin desmontar el grafo (destello instantáneo
 *    al reactivar).
 * 4. **QA**: {@link getStats} expone estado del contexto, nº de nodos persistentes
 *    y voces activas para el harness `__PAQO__`.
 *
 * No conoce viento, pads ni foley: sólo da contexto, salida y volumen. Las capas
 * (AmbientBed/Foley/UiBlips) construyen su grafo cuando el contexto existe.
 */
export class SoundscapeEngine {
  ctx: AudioContext | null = null;
  /** Bus al que se conectan todas las capas. Null hasta {@link unlock}. */
  master: GainNode | null = null;
  /** Buffers de ruido compartidos. Null hasta {@link unlock}. */
  noise: NoiseField | null = null;

  private limiter: DynamicsCompressorNode | null = null;
  private muted = getAudioMutedSafe();
  /** Techo del gain maestro (headroom para el limiter). */
  private readonly ceiling = 0.85;

  private readyCbs = new Set<(engine: SoundscapeEngine) => void>();
  private unsubMute: (() => void) | null = null;

  // --- QA ---
  private persistentNodes = 0;
  private activeVoices = 0;

  constructor() {
    this.unsubMute = subscribeAudioMuted((m) => this.applyMute(m));
  }

  /** ¿Se creó ya el contexto (hubo gesto)? */
  get created(): boolean {
    return this.ctx !== null;
  }

  /** Estado del AudioContext, o "idle" si aún no existe (sin gesto). */
  get state(): AudioContextState | "idle" {
    return this.ctx ? this.ctx.state : "idle";
  }

  /** Tiempo del contexto (s); 0 si aún no existe. */
  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** ¿Silenciado? */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Crea (si hace falta) y reanuda el AudioContext. Idempotente. Llamar desde un
   * handler de gesto del usuario (pointerdown/keydown/touch). Devuelve `true` la
   * primera vez que se crea el contexto (para que el orquestador construya capas).
   */
  unlock(): boolean {
    let firstTime = false;
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return false; // navegador sin WebAudio: silencio elegante
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.buildMasterChain();
      this.noise = {
        pink: createNoiseBuffer(this.ctx, 6, "pink"),
        white: createNoiseBuffer(this.ctx, 6, "white"),
      };
      firstTime = true;
    }
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    if (firstTime) for (const cb of this.readyCbs) cb(this);
    return firstTime;
  }

  /** Suscribe la construcción de una capa al momento en que el contexto nace. */
  onReady(cb: (engine: SoundscapeEngine) => void): void {
    this.readyCbs.add(cb);
    if (this.ctx) cb(this); // ya listo → invoca de inmediato
  }

  /** Silencia/activa y PERSISTE (delega en muteStore, que reentra por el evento). */
  setMuted(muted: boolean): void {
    setAudioMuted(muted);
  }

  private buildMasterChain(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    // Limiter suave: pilla picos sin bombear la cama ambiental.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.25;

    this.master.gain.value = this.muted ? 0 : this.ceiling;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.persistentNodes += 2;
  }

  private applyMute(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    // Rampa corta: sin clicks al silenciar/reactivar.
    g.linearRampToValueAtTime(muted ? 0 : this.ceiling, t + 0.12);
    if (!muted && this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
  }

  // ---- contabilidad para QA (las capas la alimentan) ----

  /** Registra nodos persistentes creados por una capa (para el smoke test). */
  countPersistent(n: number): void {
    this.persistentNodes += n;
  }
  /** Marca el inicio de una voz transitoria (campanilla, paso, blip). */
  voiceOn(): void {
    this.activeVoices++;
  }
  /** Marca el fin de una voz transitoria. */
  voiceOff(): void {
    this.activeVoices = Math.max(0, this.activeVoices - 1);
  }

  /** Instantánea de estado para el harness `__PAQO__`. */
  getStats(): {
    created: boolean;
    state: AudioContextState | "idle";
    muted: boolean;
    persistentNodes: number;
    activeVoices: number;
    sampleRate: number;
  } {
    return {
      created: this.created,
      state: this.state,
      muted: this.muted,
      persistentNodes: this.persistentNodes,
      activeVoices: this.activeVoices,
      sampleRate: this.ctx?.sampleRate ?? 0,
    };
  }

  dispose(): void {
    this.unsubMute?.();
    this.unsubMute = null;
    this.readyCbs.clear();
    if (this.ctx) {
      try {
        this.master?.disconnect();
        this.limiter?.disconnect();
      } catch {
        /* nodos ya sueltos */
      }
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.noise = null;
    this.persistentNodes = 0;
    this.activeVoices = 0;
  }
}

/** Lectura de mute tolerante a SSR (evita throw en el constructor del engine). */
function getAudioMutedSafe(): boolean {
  try {
    return getAudioMuted();
  } catch {
    return false;
  }
}
