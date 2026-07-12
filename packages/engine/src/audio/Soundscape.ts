import { SoundscapeEngine } from "./SoundscapeEngine";
import { AmbientBed } from "./AmbientBed";
import { Foley } from "./Foley";
import { uiSound } from "./UiBlips";
import type { ZoneSignal } from "../net/types";

/**
 * ORQUESTADOR del soundscape, cara al mundo. Compone el motor + la cama ambiental
 * + el foley y traduce eventos de juego a síntesis. Es lo único que PaqoWorld
 * instancia; el resto del audio queda encapsulado.
 *
 * Responsabilidades:
 *  - **Autoplay**: engancha el primer gesto del usuario (window, fase de captura)
 *    para crear/reanudar el AudioContext. Antes: silencio total, sin warnings.
 *  - **Construcción diferida**: al nacer el contexto, levanta la cama ambiental.
 *  - **Traducción de eventos**: zonas → densidad de campanillas + "found"; patada
 *    → pop; movimiento del controller → cadencia de pasos, salto y aterrizaje;
 *    proximidad al agua → mezcla de la capa de agua.
 *  - **UI**: enlaza el singleton {@link uiSound} al mismo motor (mismo mute).
 *
 * Volúmenes conservadores por diseño (cama ~ susurro que arropa, no que cansa).
 */
export class Soundscape {
  readonly engine = new SoundscapeEngine();
  private bed = new AmbientBed(this.engine);
  private foley = new Foley(this.engine);

  // --- cadencia de pasos (atada a la velocidad real del controller) ---
  private stepPhase = 0;
  /** Zancada (u) entre pasos: cadencia ∝ velocidad sin depender de un reloj fijo. */
  private readonly stride = 2.0;
  private wasGrounded = true;
  private airTime = 0;

  // --- proximidades cacheadas para el update ---
  private waterProx = 0;

  private gestureAttached = false;
  private readonly onGesture = (): void => {
    const firstTime = this.engine.unlock();
    if (firstTime) this.bed.build();
    // Un gesto basta para desbloquear: soltamos los listeners.
    this.detachGesture();
  };

  constructor() {
    // La UI comparte motor (mismo AudioContext y mismo mute).
    uiSound.bind(this.engine);
    // Si el contexto ya existiera (p.ej. re-bind), construye la cama.
    this.engine.onReady(() => this.bed.build());
    this.attachGesture();
  }

  // ---- autoplay: primer gesto del usuario ----

  private attachGesture(): void {
    if (this.gestureAttached || typeof window === "undefined") return;
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("pointerdown", this.onGesture, opts);
    window.addEventListener("touchstart", this.onGesture, opts);
    window.addEventListener("keydown", this.onGesture, opts);
    window.addEventListener("mousedown", this.onGesture, opts);
    this.gestureAttached = true;
  }

  private detachGesture(): void {
    if (!this.gestureAttached) return;
    const opts: AddEventListenerOptions = { capture: true };
    window.removeEventListener("pointerdown", this.onGesture, opts);
    window.removeEventListener("touchstart", this.onGesture, opts);
    window.removeEventListener("keydown", this.onGesture, opts);
    window.removeEventListener("mousedown", this.onGesture, opts);
    this.gestureAttached = false;
  }

  // ---- eventos de juego (los cablea PaqoWorld) ----

  /** Señal de zona respecto al tótem → densidad de shimmer + ceremonia "found". */
  onZoneSignal(signal: ZoneSignal): void {
    const prox = signal === "found" ? 1 : signal === "near" ? 0.7 : signal === "mid" ? 0.3 : 0.05;
    this.bed.setTotemProximity(prox);
    if (signal === "found") {
      this.foley.found(); // acorde-campana ceremonial dorado (único)
      this.bed.flourish(); // + ráfaga de chispas
    }
  }

  /** Patada de pelota (id 8 = dorada de Paqo). Lo llama onBallKick del mundo. */
  onBallKick(ballId: number, strength01 = 0.6): void {
    this.foley.kick(strength01, ballId === 8);
  }

  /** Proximidad al agua 0..1 (mezcla la capa de agua y ablanda los pasos). */
  setWaterProximity(p: number): void {
    this.waterProx = p < 0 ? 0 : p > 1 ? 1 : p;
    this.bed.setWaterProximity(this.waterProx);
  }

  /**
   * Estado de movimiento del jugador por frame. Detecta bordes salto/aterrizaje
   * y acumula la fase de pasos. `horizSpeed` en u/s; `maxSpeed` para normalizar.
   */
  setMotion(horizSpeed: number, maxSpeed: number, grounded: boolean, dt: number): void {
    // --- salto / aterrizaje por bordes de "grounded" ---
    if (grounded) {
      if (!this.wasGrounded) {
        // acaba de aterrizar: dureza ∝ tiempo en el aire.
        const hard = Math.min(1, this.airTime / 0.6);
        if (this.airTime > 0.12) this.foley.land(hard);
      }
      this.airTime = 0;
    } else {
      if (this.wasGrounded && this.airTime === 0) this.foley.jump();
      this.airTime += dt;
    }
    this.wasGrounded = grounded;

    // --- cadencia de pasos: sólo en suelo y con movimiento real ---
    if (grounded && horizSpeed > 0.4) {
      this.stepPhase += horizSpeed * dt;
      // Al correr la zancada se alarga un poco (paso más atlético).
      const stride = this.stride * (horizSpeed > maxSpeed * 0.7 ? 1.25 : 1);
      if (this.stepPhase >= stride) {
        this.stepPhase -= stride;
        const speed01 = Math.min(1, horizSpeed / maxSpeed);
        this.foley.step(speed01, this.waterProx);
      }
    } else {
      this.stepPhase = 0;
    }
  }

  /** Avanza la cama generativa. Lo llama el loop de PaqoWorld. */
  update(dt: number): void {
    this.bed.update(dt);
  }

  // ---- QA (handle __PAQO__) ----

  /** Estado del audio para el smoke test. */
  getStats(): ReturnType<SoundscapeEngine["getStats"]> {
    return this.engine.getStats();
  }

  dispose(): void {
    this.detachGesture();
    uiSound.unbind(this.engine);
    this.bed.dispose();
    this.foley.dispose();
    this.engine.dispose();
  }
}
