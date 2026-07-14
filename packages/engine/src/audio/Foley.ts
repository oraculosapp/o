import type { SoundscapeEngine } from "./SoundscapeEngine";

/**
 * FOLEY sintético: los sonidos-cuerpo del avatar y del mundo. Todo se genera al
 * vuelo (bursts de ruido + osciladores con envolventes cortas) y se enruta a un
 * bus propio con un pelín de reverb-delay para que "respire" en el valle:
 *
 *  - **Pasos**: burst de ruido filtrado, con pitch/energía según velocidad; la
 *    cadencia la marca el orquestador (atada a la velocidad real del controller).
 *  - **Salto**: soplo ascendente (ruido con bandpass que sube) + chasquido tenue.
 *  - **Aterrizaje**: thump grave (seno con caída rápida) + soplo de polvo.
 *  - **Patada de pelota**: pop percusivo (seno con caída de pitch + click). La
 *    pelota dorada (id 8) suma un armónico de campana.
 *  - **Found del tótem**: acorde-campana CEREMONIAL dorado (arpegio pentatónico
 *    con cola larga) — único, el premio sonoro de encontrar a Paqo.
 *
 * El grafo se construye perezosamente al primer evento (tras el gesto), así que
 * no cuesta nada mientras nadie camina.
 */

/** Pentatónica de La para el acorde-campana dorado del "found" (oct. 4-5). */
const FOUND_CHORD = [261.63, 329.63, 392.0, 493.88, 587.33, 659.25];

export class Foley {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  /** Delay corto compartido: aire/ambiente de todos los foley. */
  private delay: DelayNode | null = null;
  private built = false;

  constructor(private engine: SoundscapeEngine) {}

  private ensure(): boolean {
    if (this.built) return true;
    if (!this.engine.ctx || !this.engine.master || !this.engine.noise) return false;
    const ctx = this.engine.ctx;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.7;

    // Cola ambiental sutil (delay + feedback bajo) → sensación de valle abierto.
    this.delay = ctx.createDelay(0.6);
    this.delay.delayTime.value = 0.16;
    const fb = ctx.createGain();
    fb.gain.value = 0.22;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2200;
    this.delay.connect(damp);
    damp.connect(fb);
    fb.connect(this.delay);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    damp.connect(wet);

    this.bus.connect(this.engine.master);
    wet.connect(this.engine.master);
    this.built = true;
    this.engine.countPersistent(5);
    return true;
  }

  // ---- pasos ----

  /**
   * Un paso. `speed01` (0..1) escala energía y brillo; `wet` (0..1, p.ej. cerca
   * del agua) ablanda el timbre (paso húmedo). La cadencia la decide el mundo.
   */
  step(speed01: number, wet = 0): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise!.white;
    // Offset aleatorio en el buffer: dos pasos nunca idénticos.
    const dur = 0.09;
    src.loop = false;
    src.playbackRate.value = 0.9 + Math.random() * 0.3;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    // Terreno seco = crujido más agudo; húmedo = más grave y sordo.
    bp.frequency.value = (wet > 0.5 ? 320 : 520) + speed01 * 260 + Math.random() * 120;
    bp.Q.value = 0.8;

    const g = ctx.createGain();
    const peak = 0.05 + speed01 * 0.12;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    this.playThrough(src, bp, g, now, dur + 0.02);
  }

  // ---- salto y aterrizaje ----

  /** Salto: soplo ascendente + chasquido tenue. */
  jump(): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise!.white;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.0;
    bp.frequency.setValueAtTime(360, now);
    bp.frequency.exponentialRampToValueAtTime(900, now + 0.18); // sube = despegue
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    this.playThrough(src, bp, g, now, 0.24);
  }

  /** Aterrizaje: thump grave (seno) + soplo de polvo. `hard` (0..1) por impacto. */
  land(hard = 0.5): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const h = Math.max(0.15, Math.min(1, hard));

    // Thump: seno grave que cae en pitch y en volumen.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.16 * h + 0.05, now + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(og);
    og.connect(this.bus!);
    this.engine.voiceOn();
    osc.start(now);
    osc.stop(now + 0.3);
    osc.onended = () => {
      osc.disconnect();
      og.disconnect();
      this.engine.voiceOff();
    };

    // Soplo de polvo: ruido con lowpass que decae.
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise!.white;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.09 * h, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    this.playThrough(src, lp, g, now, 0.24);
  }

  // ---- patada de pelota ----

  /** Pop percusivo. `strength01` por velocidad; `golden` añade brillo de campana. */
  kick(strength01 = 0.6, golden = false): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const s = Math.max(0.2, Math.min(1, strength01));

    // Cuerpo del pop: triángulo con caída rápida de pitch.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(300 + s * 120, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.11);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.14 + s * 0.1, now + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(og);
    og.connect(this.bus!);
    og.connect(this.delay!);
    this.engine.voiceOn();
    osc.start(now);
    osc.stop(now + 0.18);
    osc.onended = () => {
      osc.disconnect();
      og.disconnect();
      this.engine.voiceOff();
    };

    // Click de contacto: micro-burst de ruido.
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise!.white;
    const bp = ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08 + s * 0.06, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    this.playThrough(src, bp, g, now, 0.06);

    // Pelota dorada de Paqo: armónico de campana que canta al golpearla.
    if (golden) {
      const bell = ctx.createOscillator();
      bell.type = "sine";
      bell.frequency.value = 987.77; // B5
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.0001, now);
      bg.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      bell.connect(bg);
      bg.connect(this.bus!);
      bg.connect(this.delay!);
      this.engine.voiceOn();
      bell.start(now);
      bell.stop(now + 1.0);
      bell.onended = () => {
        bell.disconnect();
        bg.disconnect();
        this.engine.voiceOff();
      };
    }
  }

  // ---- golpe a Paqo (mini-juego): barro cocido + destello pentatónico ----

  /**
   * "Toc" de barro cocido al golpear a Paqo con una pelota: cuerpo triangular que
   * cae en pitch (~180→90 Hz, pluck corto) + un destello de 3 parciales agudos de
   * La menor pentatónica (juguetón, tipo `found()` pero breve) + un click de ruido
   * highpass de contacto. `strength01` (0..1) escala energía y brillo.
   */
  paqoHit(strength01 = 1): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const s = Math.max(0.15, Math.min(1, strength01));

    // Cuerpo: triángulo grave con caída de pitch (barro cocido, pluck).
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.16 * s + 0.05, now + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(og);
    og.connect(this.bus!);
    og.connect(this.delay!);
    this.engine.voiceOn();
    osc.start(now);
    osc.stop(now + 0.18);
    osc.onended = () => {
      osc.disconnect();
      og.disconnect();
      this.engine.voiceOff();
    };

    // Click de contacto: micro-burst de ruido highpass.
    const src = ctx.createBufferSource();
    src.buffer = this.engine.noise!.white;
    const bp = ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07 + s * 0.06, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    this.playThrough(src, bp, g, now, 0.06);

    // Destello pentatónico: 3 parciales agudos de La menor pentatónica (A5,C6,E6),
    // arpegio muy corto y brillante — el "premio" juguetón de acertar a Paqo.
    const sparkle = [880.0, 1046.5, 1318.5];
    for (let i = 0; i < sparkle.length; i++) {
      const when = now + 0.01 + i * 0.035;
      const bell = ctx.createOscillator();
      bell.type = "sine";
      bell.frequency.value = sparkle[i];
      const bg = ctx.createGain();
      const peak = (0.07 - i * 0.015) * (0.5 + s * 0.5);
      bg.gain.setValueAtTime(0.0001, when);
      bg.gain.exponentialRampToValueAtTime(Math.max(0.008, peak), when + 0.008);
      bg.gain.exponentialRampToValueAtTime(0.0001, when + 0.5);
      bell.connect(bg);
      bg.connect(this.bus!);
      bg.connect(this.delay!);
      this.engine.voiceOn();
      bell.start(when);
      bell.stop(when + 0.55);
      bell.onended = () => {
        bell.disconnect();
        bg.disconnect();
        this.engine.voiceOff();
      };
    }
  }

  /**
   * Arpegio ascendente corto y festivo (3 notas pentatónicas) para el INICIO del
   * mini-juego. Molde de `found()` pero breve y alegre.
   */
  gameStart(): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const notes = [440.0, 587.33, 880.0]; // A4, D5, A5 — subida limpia
    for (let i = 0; i < notes.length; i++) {
      const when = now + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = notes[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.1, when + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
      osc.connect(g);
      g.connect(this.bus!);
      g.connect(this.delay!);
      this.engine.voiceOn();
      osc.start(when);
      osc.stop(when + 0.45);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
        this.engine.voiceOff();
      };
    }
  }

  /**
   * Acorde resolutivo suave para el FIN del mini-juego (molde de `found()` más
   * tenue): tríada de La menor sostenida y cálida que cierra la ronda.
   */
  gameEnd(): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const chord = [440.0, 523.25, 659.25]; // A4, C5, E5 — La menor
    for (let i = 0; i < chord.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = chord[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
      osc.connect(g);
      g.connect(this.bus!);
      g.connect(this.delay!);
      this.engine.voiceOn();
      osc.start(now);
      osc.stop(now + 1.9);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
        this.engine.voiceOff();
      };
    }
  }

  // ---- found del tótem: acorde-campana ceremonial dorado ----

  /** Único por sesión: arpegio pentatónico con cola larga — encontraste a Paqo. */
  found(): void {
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    for (let i = 0; i < FOUND_CHORD.length; i++) {
      const when = t0 + i * 0.13; // arpegio ascendente
      const freq = FOUND_CHORD[i];
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const partial = ctx.createOscillator();
      partial.type = "sine";
      partial.frequency.value = freq * 3; // brillo de campana dorada
      const g = ctx.createGain();
      const pg = ctx.createGain();
      const decay = 3.2;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.16, when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      pg.gain.setValueAtTime(0.0001, when);
      pg.gain.exponentialRampToValueAtTime(0.04, when + 0.02);
      pg.gain.exponentialRampToValueAtTime(0.0001, when + 1.4);
      osc.connect(g);
      partial.connect(pg);
      g.connect(this.bus!);
      g.connect(this.delay!);
      pg.connect(this.bus!);
      this.engine.voiceOn();
      osc.start(when);
      partial.start(when);
      osc.stop(when + decay + 0.1);
      partial.stop(when + 1.5);
      osc.onended = () => {
        osc.disconnect();
        partial.disconnect();
        g.disconnect();
        pg.disconnect();
        this.engine.voiceOff();
      };
    }
  }

  // ---- util ----

  /** Enruta src→...→gain→bus(+delay), arranca y limpia al terminar. */
  private playThrough(
    src: AudioBufferSourceNode,
    node: AudioNode,
    gain: GainNode,
    now: number,
    stopAfter: number,
  ): void {
    src.connect(node);
    node.connect(gain);
    gain.connect(this.bus!);
    gain.connect(this.delay!);
    this.engine.voiceOn();
    src.start(now);
    src.stop(now + stopAfter);
    src.onended = () => {
      src.disconnect();
      node.disconnect();
      gain.disconnect();
      this.engine.voiceOff();
    };
  }

  dispose(): void {
    if (!this.built) return;
    try {
      this.bus?.disconnect();
      this.delay?.disconnect();
    } catch {
      /* ya suelto */
    }
    this.built = false;
    this.ctx = null;
    this.bus = null;
    this.delay = null;
  }
}
