import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";

/**
 * Agua de Paqo — RETIRADA (S5).
 *
 * La laguna, el arroyo y la cascada al vacío se veían extraños y confundían, así
 * que se eliminaron de la escena: el terreno donde estaban queda como pradera
 * normal (el agua sólo se apoyaba sobre `heightAt`, nunca esculpía el suelo, así
 * que no deja hueco). Se conserva esta clase como stub inerte (misma superficie
 * pública: `build`/`addTo`/`update`/`proximityAt`/`dispose`, grupo vacío) para no
 * romper llamadas existentes; `proximityAt` devuelve 0 (el audio de agua por
 * proximidad queda en silencio). PaqoWorld ya no la instancia.
 */
export class Water {
  readonly group = new THREE.Group();

  /** Posición de la cuenca (histórica); ya sin cuerpo de agua. */
  basinPos = new THREE.Vector3();
  /** Cima de la antigua cascada al vacío; ya sin cuerpo de agua. */
  waterfallTop = new THREE.Vector3();

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
  ) {
    void this.field;
    void this.preset;
  }

  /** No construye ningún cuerpo de agua (retirada de la escena). */
  build(): void {}

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(_dt: number, _t: number): void {}

  /** Sin agua: proximidad siempre 0 (el audio de agua permanece inerte). */
  proximityAt(_x: number, _z: number): number {
    return 0;
  }

  dispose(): void {}
}
