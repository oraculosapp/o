import type { SoundscapeEngine } from "./SoundscapeEngine";

/**
 * CAMA AMBIENTAL GENERATIVA de Paqo — mood místico-contemplativo ("brumoso,
 * receptivo, umbral"). Cuatro capas, todas estocásticas (ningún bucle audible),
 * en clave de **La menor pentatónica** (A C D E G) — bruma musical, no melodía:
 *
 *  1. **Viento**: ruido rosa por un lowpass con dos LFOs lentos (frecuencia y
 *     ganancia) — la respiración del valle.
 *  2. **Pad armónico**: 3 osciladores (triángulo/seno) detuneados en acorde
 *     abierto de quintas + add9, con ataques/releases larguísimos que se deslizan
 *     lentamente a otras notas pentatónicas.
 *  3. **Campanillas/shimmer**: senos con envolvente de campana + delay/feedback,
 *     esporádicos (8-25 s). La densidad SUBE cerca del tótem (near/found) y casi
 *     desaparece lejos.
 *  4. **Agua**: ruido blanco bandpass con burbujeo (LFO rápido), mezclado por
 *     proximidad a los cuerpos de agua.
 *
 * Toda la aleatoriedad se agenda desde {@link update} (atada al rAF del mundo):
 * sin `setInterval`/`setTimeout` sueltos que sobrevivan al dispose.
 */

// --- material musical (Hz) ---
/** Registro grave para el pad (La menor pentatónica, oct. 2-3). */
const PAD_SCALE = [110.0, 130.81, 146.83, 164.81, 196.0, 220.0];
/** Registro agudo para las campanillas (oct. 5-6). */
const BELL_SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
/** Acorde inicial abierto del pad (raíz A2 · quinta E3 · add9 B3-ish→ usamos D3). */
const PAD_START = [110.0, 164.81, 146.83];

interface PadVoice {
  osc: OscillatorNode;
  gain: GainNode;
  /** Segundos restantes hasta el próximo cambio de nota. */
  timer: number;
  base: number;
}

export class AmbientBed {
  private ctx!: AudioContext;
  private bus!: GainNode;

  // viento
  private windSrc!: AudioBufferSourceNode;
  private windGain!: GainNode;
  // pad
  private padVoices: PadVoice[] = [];
  private padFilter!: BiquadFilterNode;
  // shimmer
  private shimmerGain!: GainNode;
  private shimmerDelay!: DelayNode;
  private bellTimer = 6;
  // agua
  private waterSrc!: AudioBufferSourceNode;
  private waterBP!: BiquadFilterNode;
  private waterGain!: GainNode;
  private waterTarget = 0;

  // Los LFO viven aparte para poder pararlos en dispose.
  private lfos: OscillatorNode[] = [];
  private built = false;

  /** Proximidad al tótem 0..1 (1 = encima). Controla densidad de campanillas. */
  private totemProx = 0;

  constructor(private engine: SoundscapeEngine) {}

  /** Construye TODO el grafo persistente. Sólo cuando el contexto ya existe. */
  build(): void {
    if (this.built || !this.engine.ctx || !this.engine.master || !this.engine.noise) return;
    this.ctx = this.engine.ctx;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.engine.master);

    this.buildWind();
    this.buildPad();
    this.buildShimmer();
    this.buildWater();

    this.built = true;
    this.engine.countPersistent(1); // el bus
  }

  // ---- 1. viento: ruido rosa filtrado, respiración del valle ----

  private buildWind(): void {
    const ctx = this.ctx;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.engine.noise!.pink;
    this.windSrc.loop = true;
    this.windSrc.playbackRate.value = 0.8 + Math.random() * 0.1;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.5;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.06; // muy bajo

    // LFO de frecuencia (0.06 Hz): el filtro respira ±180 Hz.
    this.addLfo(0.06, 180, filter.frequency, "sine");
    // LFO de ganancia (0.045 Hz): el volumen sube y baja ±0.03 (oleaje).
    this.addLfo(0.045, 0.03, this.windGain.gain, "sine");

    this.windSrc.connect(filter);
    filter.connect(this.windGain);
    this.windGain.connect(this.bus);
    this.windSrc.start();
    this.engine.countPersistent(3);
  }

  // ---- 2. pad armónico: acorde abierto que se desliza por la pentatónica ----

  private buildPad(): void {
    const ctx = this.ctx;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.7;
    // LFO lentísimo sobre el corte del pad → la bruma se mueve.
    this.addLfo(0.03, 220, this.padFilter.frequency, "sine");

    const padGain = ctx.createGain();
    padGain.gain.value = 0.05; // muy bajo, sólo arropa
    this.padFilter.connect(padGain);
    padGain.connect(this.bus);

    const detune = [-6, +5, +9]; // cents: coro suave
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 2 ? "sine" : "triangle";
      osc.frequency.value = PAD_START[i];
      osc.detune.value = detune[i];
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(gain);
      gain.connect(this.padFilter);
      osc.start();
      // Ataque larguísimo de entrada (8-12 s) hasta su volumen de voz.
      const vol = 0.9 - i * 0.15;
      gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 4.5);
      this.padVoices.push({ osc, gain, timer: 12 + Math.random() * 12, base: PAD_START[i] });
    }
    this.engine.countPersistent(3 + 3 + 1); // 3 osc + 3 gain + padGain
  }

  // ---- 3. campanillas/shimmer: senos de campana + delay con feedback ----

  private buildShimmer(): void {
    const ctx = this.ctx;
    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = 0.5;
    this.shimmerGain.connect(this.bus);

    // Red de delay con feedback amortiguado: la "cola mística" de cada chispa.
    this.shimmerDelay = ctx.createDelay(1.5);
    this.shimmerDelay.delayTime.value = 0.32;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2600;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    this.shimmerDelay.connect(damp);
    damp.connect(feedback);
    feedback.connect(this.shimmerDelay);
    damp.connect(this.shimmerGain);
    this.engine.countPersistent(4);
  }

  /**
   * Dispara una campanilla (seno de campana) hacia seco + delay. `offset` agenda
   * el ataque en el futuro sobre el reloj del CONTEXTO (sin setTimeout, sin fugas)
   * — lo usa el flourish del "found". `pick` fuerza un grado de la escala.
   */
  private ringBell(offset = 0, pick = -1): void {
    const ctx = this.ctx;
    const now = ctx.currentTime + offset;
    const idx = pick >= 0 ? pick % BELL_SCALE.length : (Math.random() * BELL_SCALE.length) | 0;
    const freq = BELL_SCALE[idx];

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Un armónico agudo tenue le da brillo de campana.
    const partial = ctx.createOscillator();
    partial.type = "sine";
    partial.frequency.value = freq * 2.01;

    const g = ctx.createGain();
    const pg = ctx.createGain();
    const peak = 0.18 + this.totemProx * 0.18;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
    pg.gain.setValueAtTime(0.0001, now);
    pg.gain.exponentialRampToValueAtTime(peak * 0.3, now + 0.008);
    pg.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);

    osc.connect(g);
    partial.connect(pg);
    g.connect(this.shimmerGain);
    g.connect(this.shimmerDelay);
    pg.connect(this.shimmerGain);
    pg.connect(this.shimmerDelay);

    this.engine.voiceOn();
    osc.start(now);
    partial.start(now);
    osc.stop(now + 2.8);
    partial.stop(now + 1.5);
    const cleanup = (): void => {
      osc.disconnect();
      partial.disconnect();
      g.disconnect();
      pg.disconnect();
      this.engine.voiceOff();
    };
    osc.onended = cleanup;
  }

  // ---- 4. agua: ruido blanco bandpass con burbujeo, por proximidad ----

  private buildWater(): void {
    const ctx = this.ctx;
    this.waterSrc = ctx.createBufferSource();
    this.waterSrc.buffer = this.engine.noise!.white;
    this.waterSrc.loop = true;

    this.waterBP = ctx.createBiquadFilter();
    this.waterBP.type = "bandpass";
    this.waterBP.frequency.value = 950;
    this.waterBP.Q.value = 1.4;
    // Burbujeo: LFO rápido (6.5 Hz) sobre la frecuencia del bandpass.
    this.addLfo(6.5, 420, this.waterBP.frequency, "sine");
    // Oleaje lento del propio caudal.
    this.addLfo(0.5, 260, this.waterBP.frequency, "triangle");

    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0; // silencioso hasta acercarse

    this.waterSrc.connect(this.waterBP);
    this.waterBP.connect(this.waterGain);
    this.waterGain.connect(this.bus);
    this.waterSrc.start();
    this.engine.countPersistent(3);
  }

  // ---- API pública para el orquestador ----

  /** Proximidad al tótem 0..1: densidad y brillo de campanillas. */
  setTotemProximity(p: number): void {
    this.totemProx = clamp01(p);
  }

  /** Proximidad al agua 0..1: mezcla la capa de agua (ramp suave). */
  setWaterProximity(p: number): void {
    this.waterTarget = clamp01(p);
    if (this.built) {
      this.waterGain.gain.setTargetAtTime(this.waterTarget * 0.05, this.ctx.currentTime, 0.4);
    }
  }

  /**
   * Ráfaga de shimmer para el momento "found": arpegio ascendente de campanillas
   * agendado sobre el reloj del contexto (chispas ceremoniales que rematan el
   * acorde-campana dorado del Foley).
   */
  flourish(): void {
    if (!this.built) return;
    const grades = [2, 3, 4, 5]; // E5 G5 A5 C6 — ascenso luminoso
    for (let i = 0; i < grades.length; i++) {
      this.ringBell(i * 0.16, grades[i]);
    }
  }

  /** Avanza los procesos estocásticos (agendado por el rAF del mundo). */
  update(dt: number): void {
    if (!this.built) return;

    // Pad: cada voz se desliza a otra nota pentatónica cuando su timer expira.
    for (const v of this.padVoices) {
      v.timer -= dt;
      if (v.timer <= 0) {
        v.timer = 12 + Math.random() * 14;
        const next = PAD_SCALE[(Math.random() * PAD_SCALE.length) | 0];
        const now = this.ctx.currentTime;
        // Glissando larguísimo (portamento) + leve "respiración" de volumen.
        v.osc.frequency.setTargetAtTime(next, now, 3.5);
        v.base = next;
        v.gain.gain.setTargetAtTime(0.5, now, 1.2);
        v.gain.gain.setTargetAtTime(0.85, now + 4, 3);
      }
    }

    // Campanillas: intervalo según proximidad al tótem (cerca = más densas).
    this.bellTimer -= dt;
    if (this.bellTimer <= 0) {
      this.ringBell();
      const near = this.totemProx;
      // Lejos: 14-25 s · Cerca: 4-9 s.
      const lo = lerp(14, 4, near);
      const hi = lerp(25, 9, near);
      this.bellTimer = lo + Math.random() * (hi - lo);
    }
  }

  dispose(): void {
    if (!this.built) return;
    try {
      this.windSrc.stop();
      this.waterSrc.stop();
      for (const v of this.padVoices) v.osc.stop();
      for (const l of this.lfos) l.stop();
    } catch {
      /* ya parados */
    }
    // Desconexión perezosa: cerrar el contexto (engine.dispose) libera el resto.
    try {
      this.bus.disconnect();
    } catch {
      /* ya suelto */
    }
    this.padVoices = [];
    this.lfos = [];
    this.built = false;
  }

  // ---- util ----

  /** Crea un LFO (osc + gain de profundidad) hacia un AudioParam y lo registra. */
  private addLfo(freq: number, depth: number, target: AudioParam, type: OscillatorType): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(target);
    osc.start();
    this.lfos.push(osc);
    this.engine.countPersistent(2);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
