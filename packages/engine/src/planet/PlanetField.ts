import * as THREE from "three";
import { SimplexNoise } from "../noise";
import type { BiospherePreset } from "./types";

/**
 * Campo de desplazamiento del planeta: dada una dirección normalizada devuelve
 * la altura (offset radial) de la superficie. Es la ÚNICA fuente de verdad de
 * la forma del terreno — la usa tanto la malla visual como el hitmesh low-poly,
 * de modo que ambos coinciden razonablemente.
 *
 * Forma de Paqo = fBm + ridges (laderas) + anillo-anfiteatro alrededor del
 * claro + claro central plano e ÍNTIMO en el polo +Y (centralClearing), donde
 * vive la runa y hace spawn el jugador.
 */
export class PlanetField {
  readonly radius: number;
  private noise: SimplexNoise;
  private amp: number;
  private freq: number;
  private octaves: number;
  private ridgeStrength: number;
  private clearDir = new THREE.Vector3(0, 1, 0);
  private clearFlatness: number;
  private clearAngle: number; // radio angular del claro (rad)
  private clearFade: number; // ancho angular de la transición (rad)
  // Anillo-anfiteatro: cresta anular que rodea el claro (la ficha de Paqo es
  // "valle en U con claro central rodeado de montañas").
  private rimAngle: number;
  private rimSigma: number;
  private rimHeight: number;

  // Vector de trabajo reutilizable (sin asignaciones por muestra).
  private _n = new THREE.Vector3();

  constructor(preset: BiospherePreset, radius: number, seed = 20260710) {
    this.radius = radius;
    this.noise = new SimplexNoise(seed);

    const hn = preset.terrain.heightNoise;
    // El preset trae amplitude/frequency en unidades de terreno plano gigante;
    // se reescala a la esfera pequeña del mundo jugable.
    this.amp = (hn.amplitude / 42) * 7.5;
    // ×230 (antes ×130): relieve más estrecho, a escala del personaje — las
    // laderas se leen desde el claro en vez de fundirse en colinas continentales.
    this.freq = hn.frequency * 230;
    this.octaves = hn.octaves;

    this.ridgeStrength = preset.terrain.ridges?.enabled
      ? preset.terrain.ridges.steepness
      : 0;

    const clearing = preset.terrain.centralClearing;
    this.clearFlatness = clearing?.enabled ? clearing.flatness : 0;
    // radius del preset viene en unidades de terreno plano; se reescala a un
    // escenario íntimo alrededor de la runa: 30 → 9 u de mundo (~13° en r=40),
    // con transición suave de ~6 u. Máscara angular con smoothstep, no pow().
    const clearWorldRadius = ((clearing?.radius ?? 30) / 30) * 9;
    this.clearAngle = clearWorldRadius / radius;
    this.clearFade = 6 / radius;

    // Anfiteatro: pico anular a ~20 u de arco del centro del claro, sigma ~8 u,
    // +4.5 u de altura. Empieza a subir justo tras el borde del claro (9+6 u),
    // así las laderas se ven desde el spawn sin que el horizonte de la esfera
    // (r=40) las oculte; la niebla las funde al fondo.
    this.rimAngle = 20 / radius;
    this.rimSigma = 8 / radius;
    this.rimHeight = 4.5;
  }

  /** Altura (offset radial) para una dirección. `dir` debe estar normalizada. */
  heightAt(dir: THREE.Vector3): number {
    const f = this.freq;
    // fBm base (relieve continuo sin costuras sobre la esfera).
    const base = this.noise.fbm(dir.x * f, dir.y * f, dir.z * f, this.octaves, 0.5, 2);

    // Componente "ridged" (1 - |noise|)^2 acentúa crestas/laderas del valle.
    let h = base;
    if (this.ridgeStrength > 0) {
      const rn = this.noise.noise3D(dir.x * f * 1.7 + 11.3, dir.y * f * 1.7, dir.z * f * 1.7);
      const ridged = 1 - Math.abs(rn);
      h = base * (1 - this.ridgeStrength * 0.45) + ridged * ridged * this.ridgeStrength * 0.9;
    }
    h *= this.amp;

    const angle = this.angleFromClearing(dir);

    // Anillo-anfiteatro alrededor del claro (gaussiana sobre el ángulo).
    const dRim = (angle - this.rimAngle) / this.rimSigma;
    h += Math.exp(-dRim * dRim) * this.rimHeight;

    // Aplanar el claro central hacia una pradera a media-altura.
    const flat = this.clearingMaskFromAngle(angle);
    if (flat > 0) {
      const plateau = this.amp * 0.15; // altura de la pradera del claro
      h = h * (1 - flat * this.clearFlatness) + plateau * flat * this.clearFlatness;
    }

    return h;
  }

  /** Ángulo (rad) entre `dir` y el centro del claro (+Y). */
  private angleFromClearing(dir: THREE.Vector3): number {
    return Math.acos(THREE.MathUtils.clamp(dir.dot(this.clearDir), -1, 1));
  }

  /** Máscara [0..1] del claro: 1 dentro del radio, fade suave de ~6 u, 0 fuera. */
  clearingMask(dir: THREE.Vector3): number {
    if (this.clearFlatness <= 0) return 0;
    return this.clearingMaskFromAngle(this.angleFromClearing(dir));
  }

  private clearingMaskFromAngle(angle: number): number {
    if (this.clearFlatness <= 0) return 0;
    return 1 - THREE.MathUtils.smoothstep(angle, this.clearAngle, this.clearAngle + this.clearFade);
  }

  /** Posición de mundo sobre la superficie para una dirección normalizada. */
  surfacePoint(dir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const h = this.heightAt(dir);
    return out.copy(dir).multiplyScalar(this.radius + h);
  }

  /** Desplaza in-place una geometría de esfera unidad-escalada al radio base. */
  displace(geo: THREE.BufferGeometry): void {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      this._n.fromBufferAttribute(pos, i).normalize();
      const h = this.heightAt(this._n);
      const r = this.radius + h;
      pos.setXYZ(i, this._n.x * r, this._n.y * r, this._n.z * r);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
}
