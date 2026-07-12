import type * as THREE from "three";
import type { ZoneSignal } from "./types";

/**
 * Índice de banda por proximidad al tótem (mayor = más lejos):
 *   0 = interior (<6 u, "found"/"near") · 1 = "near" (6..18) ·
 *   2 = "mid" (18..35) · 3 = "far" (>35).
 * Frontera[z] = distancia por encima de la cual se pasa a la banda z+1.
 */
const BOUNDS = [6, 18, 35];
/** Histéresis (u): margen simétrico para no parpadear en las fronteras. */
const HYSTERESIS = 2;

/**
 * Señales de zona respecto al tótem (origen del claro). Emite SÓLO al cambiar de
 * banda, con histéresis de ±2 u para evitar parpadeo. `found` (<6 u) se emite una
 * única vez por sesión; entradas posteriores al interior cuentan como `near`.
 */
export class ZoneSignals {
  private cbs = new Set<(s: ZoneSignal) => void>();
  private zone = -1; // -1 = sin inicializar (emite la banda inicial en el primer tick)
  private foundFired = false;

  /** Centro del tótem en XZ (el claro está en el origen). */
  constructor(
    private readonly cx = 0,
    private readonly cz = 0,
  ) {}

  onSignal(cb: (s: ZoneSignal) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** ¿Ya se disparó "found" en esta sesión? (persistible por quien consuma). */
  get found(): boolean {
    return this.foundFired;
  }

  /** Distancia horizontal actual al tótem (para el smoke test). */
  distance(playerPos: THREE.Vector3): number {
    return Math.hypot(playerPos.x - this.cx, playerPos.z - this.cz);
  }

  /** Evalúa la banda con histéresis y emite si cambió. */
  update(playerPos: THREE.Vector3): void {
    const d = this.distance(playerPos);

    if (this.zone < 0) {
      // Primer tick: fija la banda inicial (sin histéresis) y la emite una vez.
      this.zone = this.rawZone(d);
      this.emit(this.zone);
      return;
    }

    let z = this.zone;
    // Salir hacia una banda MÁS LEJANA: cruzar la frontera superior + histéresis.
    while (z < BOUNDS.length && d > BOUNDS[z] + HYSTERESIS) z++;
    // Salir hacia una banda MÁS CERCANA: cruzar la frontera inferior − histéresis.
    while (z > 0 && d < BOUNDS[z - 1] - HYSTERESIS) z--;

    if (z !== this.zone) {
      this.zone = z;
      this.emit(z);
    }
  }

  /** Banda cruda por distancia (sin histéresis), para inicialización. */
  private rawZone(d: number): number {
    if (d > BOUNDS[2]) return 3;
    if (d > BOUNDS[1]) return 2;
    if (d > BOUNDS[0]) return 1;
    return 0;
  }

  private emit(zone: number): void {
    let signal: ZoneSignal;
    if (zone === 3) signal = "far";
    else if (zone === 2) signal = "mid";
    else if (zone === 1) signal = "near";
    else {
      // Interior (<6 u): "found" la primera vez, luego "near".
      if (!this.foundFired) {
        this.foundFired = true;
        signal = "found";
      } else {
        signal = "near";
      }
    }
    for (const cb of this.cbs) cb(signal);
  }

  dispose(): void {
    this.cbs.clear();
  }
}
