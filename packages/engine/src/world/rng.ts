import * as THREE from "three";

/**
 * PRNG determinista (mulberry32). Semilla fija → el valle de Paqo se genera
 * idéntico en cada carga (money-shot reproducible, útil para QA de composición).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Dirección normalizada aleatoria dentro de un casquete angular alrededor de
 * `axis` (por defecto +Y, el claro de Paqo). `maxAngle` en radianes.
 * Muestreo uniforme en área sobre el casquete.
 */
export function randomDirInCap(
  rand: () => number,
  maxAngle: number,
  axis = new THREE.Vector3(0, 1, 0),
  minAngle = 0,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const cosMax = Math.cos(maxAngle);
  const cosMin = Math.cos(minAngle);
  const cosT = cosMin + (cosMax - cosMin) * rand();
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rand() * Math.PI * 2;
  // Base ortonormal alrededor de axis.
  const a = axis.clone().normalize();
  const t = Math.abs(a.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(t, a).normalize();
  const v = new THREE.Vector3().crossVectors(a, u);
  out
    .copy(a)
    .multiplyScalar(cosT)
    .addScaledVector(u, sinT * Math.cos(phi))
    .addScaledVector(v, sinT * Math.sin(phi));
  return out.normalize();
}
