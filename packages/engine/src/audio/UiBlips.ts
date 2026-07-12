import type { SoundscapeEngine } from "./SoundscapeEngine";

/**
 * BLIPS DE UI — la voz sintética de la interfaz de Phygitalia. API pública y
 * sencilla para que el HUD/chat la use MÁS ADELANTE (aquí NO se cablea ningún
 * componente): sonidos cortos "de marca" (senos/triángulos suaves con envolvente
 * breve, nunca beeps ásperos), en la pentatónica dorada para casar con la cama.
 *
 * ── Cómo lo usará la UI (apps/web), cuando toque cablearlo ─────────────────────
 *   import { uiSound } from "@phygitalia/engine";
 *   <button
 *     onPointerEnter={() => uiSound.play("hover")}
 *     onClick={() => uiSound.play("click")}
 *   />
 *   // otros: "open" (panel), "close" (panel), "send" (mensaje), "notify" (aviso)
 *
 * El singleton se ENLAZA al motor del mundo (mismo AudioContext y mismo mute) vía
 * {@link bind} — lo hace el orquestador Soundscape. Antes de enlazar, `play()` es
 * un no-op silencioso: la UI puede llamarlo siempre sin comprobar nada.
 */
export type UiSoundKind = "hover" | "click" | "open" | "close" | "send" | "notify";

interface Blip {
  /** Frecuencia(s) base en Hz. Varias = mini-arpegio (open/send/notify). */
  freqs: number[];
  type: OscillatorType;
  /** Separación entre notas del arpegio (s). */
  stagger: number;
  /** Pico de ganancia. */
  peak: number;
  /** Duración de cada nota (s). */
  dur: number;
}

// Diseño sonoro: pentatónica de La, registro medio-agudo, discreto.
const BLIPS: Record<UiSoundKind, Blip> = {
  // hover: roce apenas perceptible, agudo y cortísimo.
  hover: { freqs: [880.0], type: "sine", stagger: 0, peak: 0.03, dur: 0.05 },
  // click: confirmación seca, un grado más grave que hover.
  click: { freqs: [659.25], type: "triangle", stagger: 0, peak: 0.06, dur: 0.07 },
  // open: díada ascendente (algo se despliega).
  open: { freqs: [587.33, 880.0], type: "sine", stagger: 0.06, peak: 0.05, dur: 0.12 },
  // close: díada descendente (algo se recoge).
  close: { freqs: [880.0, 587.33], type: "sine", stagger: 0.06, peak: 0.045, dur: 0.1 },
  // send: tríada ascendente breve (mensaje que sale).
  send: { freqs: [659.25, 783.99, 1046.5], type: "triangle", stagger: 0.05, peak: 0.05, dur: 0.09 },
  // notify: campanilla doble cálida (aviso que llama con suavidad).
  notify: { freqs: [783.99, 1174.66], type: "sine", stagger: 0.11, peak: 0.06, dur: 0.35 },
};

class UiBlips {
  private engine: SoundscapeEngine | null = null;
  private bus: GainNode | null = null;

  /** Enlaza al motor del mundo (comparte contexto, salida y mute). */
  bind(engine: SoundscapeEngine): void {
    this.engine = engine;
    this.bus = null; // se (re)construye perezosamente en play()
  }

  /** Desenlaza (al hacer dispose del mundo). Vuelve a no-op silencioso. */
  unbind(engine: SoundscapeEngine): void {
    if (this.engine === engine) {
      try {
        this.bus?.disconnect();
      } catch {
        /* ya suelto */
      }
      this.engine = null;
      this.bus = null;
    }
  }

  /**
   * Reproduce un blip. Seguro de llamar SIEMPRE: sin motor, sin contexto (sin
   * gesto todavía) o silenciado → no-op. Un gesto de UI (click) ya reanuda el
   * contexto, así que los blips "click/open/send" suenan a la primera.
   */
  play(kind: UiSoundKind): void {
    const engine = this.engine;
    if (!engine) return;
    // La interacción de UI ES un gesto → intenta desbloquear el contexto.
    engine.unlock();
    const ctx = engine.ctx;
    const master = engine.master;
    if (!ctx || !master) return;

    if (!this.bus) {
      this.bus = ctx.createGain();
      this.bus.gain.value = 0.6;
      this.bus.connect(master);
      engine.countPersistent(1);
    }

    const spec = BLIPS[kind];
    const t0 = ctx.currentTime;
    for (let i = 0; i < spec.freqs.length; i++) {
      const when = t0 + i * spec.stagger;
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = spec.freqs[i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(spec.peak, when + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, when + spec.dur);
      osc.connect(g);
      g.connect(this.bus);
      engine.voiceOn();
      osc.start(when);
      osc.stop(when + spec.dur + 0.02);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
        engine.voiceOff();
      };
    }
  }
}

/**
 * Singleton de blips de UI. Exportado por `@phygitalia/engine` para que el HUD lo
 * use. La UI sólo llama `uiSound.play(kind)`; el enlace al motor lo gestiona el
 * mundo. Ver el bloque de documentación arriba para el patrón de cableado.
 */
export const uiSound = new UiBlips();
export type { UiBlips };
