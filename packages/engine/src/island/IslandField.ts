import * as THREE from "three";
import { SimplexNoise } from "../noise";
import type { BiospherePreset } from "../planet/types";

/**
 * Campo de altura de la ISLA FLOTANTE (heightmap 2D). Es la ÚNICA fuente de
 * verdad de la forma del terreno: la usan por igual la malla visual, la colisión
 * analítica del controller y el posado de la vegetación (el patrón que ya
 * validamos en la esfera, ahora en coordenadas planas x/z con up = (0,1,0)).
 *
 * Forma de Paqo (portada 1:1 de PlanetField, gravedad -Y):
 *   fBm + ridges (laderas) + anillo-anfiteatro alrededor del claro + claro
 *   central plano en el origen + DOS pasos de cañón (±X) que rompen la jaula +
 *   máscara de isla: falloff orgánico (silueta no circular por ruido de dominio
 *   en el radio) que cae al acantilado y a la panza rocosa flotando en la niebla.
 *
 * Escala de referencia: en la esfera todo se medía en radianes sobre un radio
 * R=40. Aquí conservamos EXACTAMENTE los mismos tamaños de mundo convirtiendo
 * cada ángulo θ a distancia planar r = θ·R (documentado en cada constante).
 */
export class IslandField {
  private noise: SimplexNoise;
  private amp: number;
  private freq: number; // frecuencia planar (por unidad de mundo)
  private octaves: number;
  private ridgeStrength: number;

  // Claro central plano (origen).
  private clearFlatness: number;
  private clearRadius: number; // u de mundo
  private clearFade: number; // u de mundo

  // Anillo-anfiteatro.
  private rimRadius: number; // u
  private rimSigma: number; // u
  private rimHeight: number; // u

  // Pasos del cañón (±X): corredores llanos que atraviesan el anillo.
  private gateAzimuth = 0; // rad (eje +X)
  private gateSigma = 0.32; // medio-ancho azimutal (rad) → paso de ~10 u

  // --- Isla flotante: silueta orgánica + acantilado ---
  /** Radio base de la isla (u). En la esfera el mundo jugable llegaba a ~55-60 u. */
  static readonly EDGE_BASE = 56;
  /** Amplitud del ruido de silueta (u): borde orgánico en ~49..63 u. */
  private static readonly EDGE_WARP = 7;
  /** Anchura del hombro donde el terreno redondea hacia el filo (u). */
  private static readonly LIP_WIDTH = 6;
  /** Caída del hombro justo antes del vacío (u). */
  private static readonly LIP_DROP = 2.2;
  /** Nivel base de referencia del claro (para umbrales de caída). */
  readonly clearLevel: number;

  // Escala de referencia esférica (solo para convertir los números aprobados).
  private static readonly R_REF = 40;

  // Vectores de trabajo reutilizables (sin asignaciones por muestra).
  private _t = new THREE.Vector3();

  constructor(preset: BiospherePreset, seed = 20260710) {
    this.noise = new SimplexNoise(seed);

    const hn = preset.terrain.heightNoise;
    // Amplitud idéntica a la esfera: (amplitude/42)*7.5 = 7.5 u.
    this.amp = (hn.amplitude / 42) * 7.5;
    // Frecuencia planar: en la esfera el ruido tomaba dir·(f) con f = freq·230 y
    // dir unitario; una unidad de mundo movía dir en 1/R, así que la frecuencia
    // horizontal efectiva era (freq·230)/R por unidad. La conservamos tal cual.
    this.freq = (hn.frequency * 230) / IslandField.R_REF; // 0.012·230/40 = 0.069
    this.octaves = hn.octaves;

    this.ridgeStrength = preset.terrain.ridges?.enabled ? preset.terrain.ridges.steepness : 0;

    const clearing = preset.terrain.centralClearing;
    this.clearFlatness = clearing?.enabled ? clearing.flatness : 0;
    // 30 → 9 u de claro íntimo, transición ~6 u (idénticos a la esfera).
    this.clearRadius = ((clearing?.radius ?? 30) / 30) * 9;
    this.clearFade = 6;

    // Anfiteatro: θ=20/R·R = 20 u de radio, σ=8 u, +4.5 u (idénticos a la esfera).
    this.rimRadius = 20;
    this.rimSigma = 8;
    this.rimHeight = 4.5;

    // Altura del claro (pradera a media altura) para umbrales de caída al vacío.
    this.clearLevel = this.amp * 0.15;
  }

  // ---- silueta orgánica de la isla ----

  /** Radio del filo de la isla para el azimut de (x,z). Ruido suave y sin costura. */
  edgeRadiusAt(x: number, z: number): number {
    const r = Math.hypot(x, z) || 1e-4;
    const cx = x / r;
    const cz = z / r;
    // Ruido sobre el círculo unidad (seamless en az=±π) + segundo armónico.
    const w1 = this.noise.noise3D(cx * 1.6, 7.7, cz * 1.6);
    const w2 = this.noise.noise3D(cx * 3.3 + 4.1, 2.3, cz * 3.3);
    const warp = w1 * 0.75 + w2 * 0.25;
    return IslandField.EDGE_BASE + warp * IslandField.EDGE_WARP;
  }

  /** ¿El punto (x,z) está sobre la isla? Fuera del filo = vacío (el jugador cae). */
  insideIsland(x: number, z: number): boolean {
    return Math.hypot(x, z) <= this.edgeRadiusAt(x, z);
  }

  // ---- máscaras ----

  /** Máscara [0..1] del claro central: 1 dentro del radio, fade suave, 0 fuera. */
  clearingMask(x: number, z: number): number {
    if (this.clearFlatness <= 0) return 0;
    const r = Math.hypot(x, z);
    return 1 - THREE.MathUtils.smoothstep(r, this.clearRadius, this.clearRadius + this.clearFade);
  }

  /** Máscara [0..1] de los dos corredores de salida (azimutal × zona radial). */
  private gateMask(x: number, z: number, r: number): number {
    // Zona radial: del borde del claro (~11 u) hasta cerca del filo (~62 u), para
    // que el corredor +X lleve el río hasta el borde y ambos pasos sean salidas.
    const zone =
      THREE.MathUtils.smoothstep(r, 11.2, 16.8) * (1 - THREE.MathUtils.smoothstep(r, 48, 62));
    if (zone <= 0.001) return 0;
    const az = Math.atan2(z, x);
    const d0 = Math.atan2(Math.sin(az - this.gateAzimuth), Math.cos(az - this.gateAzimuth));
    const d1 = Math.atan2(
      Math.sin(az - this.gateAzimuth - Math.PI),
      Math.cos(az - this.gateAzimuth - Math.PI),
    );
    const s2 = 2 * this.gateSigma * this.gateSigma;
    const g = Math.max(Math.exp(-(d0 * d0) / s2), Math.exp(-(d1 * d1) / s2));
    return g * zone;
  }

  // ---- altura ----

  /** Altura (Y) del terreno en (x,z). Misma fórmula que desplaza la malla visual. */
  heightAt(x: number, z: number): number {
    const f = this.freq;
    // fBm base (relieve continuo). Segundo eje fijo → heightmap 2D determinista.
    const base = this.noise.fbm(x * f, 37.5, z * f, this.octaves, 0.5, 2);

    let h = base;
    if (this.ridgeStrength > 0) {
      const rn = this.noise.noise3D(x * f * 1.7 + 11.3, 5.1, z * f * 1.7);
      const ridged = 1 - Math.abs(rn);
      // Peso ridged 0.75 (idéntico a la esfera: la mejor caminata "deliciosa").
      h = base * (1 - this.ridgeStrength * 0.45) + ridged * ridged * this.ridgeStrength * 0.75;
    }
    h *= this.amp;

    const r = Math.hypot(x, z);

    // Anillo-anfiteatro (gaussiana sobre el radio planar).
    const dRim = (r - this.rimRadius) / this.rimSigma;
    h += Math.exp(-dRim * dRim) * this.rimHeight;

    // Pasos del cañón: blend hacia una vega a la altura de la pradera.
    const gate = this.gateMask(x, z, r);
    if (gate > 0) {
      const floor = this.amp * 0.18;
      const g = gate * 0.8;
      h = h * (1 - g) + floor * g;
    }

    // Aplanar el claro central hacia la pradera de media altura.
    const flat = this.clearingMask(x, z);
    if (flat > 0) {
      const plateau = this.amp * 0.15;
      h = h * (1 - flat * this.clearFlatness) + plateau * flat * this.clearFlatness;
    }

    // Hombro del filo: el terreno redondea hacia abajo justo antes del vacío
    // (el acantilado dramático es la falda, malla aparte).
    const edge = this.edgeRadiusAt(x, z);
    const lipT = THREE.MathUtils.smoothstep(r, edge - IslandField.LIP_WIDTH, edge);
    h -= lipT * IslandField.LIP_DROP;

    return h;
  }

  /** Posición de mundo sobre la superficie en (x,z). */
  surfacePoint(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(x, this.heightAt(x, z), z);
  }

  /**
   * Normal de la superficie por diferencias finitas de heightAt (paso ≈ 0.7 u,
   * la resolución de la malla visual). Analítica y continua — coincide con lo
   * que se ve. La usa el controller para pendiente y el blob sin raycasts.
   */
  surfaceNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const eps = 0.7;
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);
    return out.set(-dhdx, 1, -dhdz).normalize();
  }

  /** Pendiente (rad) del terreno en (x,z): ángulo entre la normal y +Y. */
  slopeAt(x: number, z: number): number {
    this.surfaceNormal(x, z, this._t);
    return Math.acos(THREE.MathUtils.clamp(this._t.y, -1, 1));
  }
}
