import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import { makeToonRamp } from "../util/toon";

/**
 * Un aro de proximidad: círculo emisivo en el suelo, del color del lore de su
 * Oráculo. `nearR` es el radio (u, en XZ) que lo enciende.
 */
export type OracleRingSpec<T extends string = string> = {
  /** Id del quest. `null` = Paqo: su aro se enciende igual pero no emite evento. */
  id: T | null;
  x: number;
  z: number;
  /** Radio del aro (u). Proporcional a la huella del tótem. */
  radius: number;
  /** Color emisivo (hex del lore). */
  color: number;
  /** Radio de cercanía (u) que lo enciende. */
  nearR: number;
};

/** Entrada viva de un aro (los adoptados no se liberan aquí: no son nuestros). */
type Entry<T extends string> = {
  id: T | null;
  x: number;
  z: number;
  nearSq: number;
  /** Histéresis: se apaga un poco más lejos de lo que se encendió (sin parpadeo). */
  farSq: number;
  mesh: THREE.Mesh;
  mat: THREE.MeshToonMaterial;
  owned: boolean;
  /** Fade actual [0..1]. */
  k: number;
  inside: boolean;
};

/**
 * Aros de proximidad de los Oráculos. Cada tótem tiene un anillo emisivo en el
 * suelo, INVISIBLE hasta que el viajero se acerca: entra con fade rápido (~0.4 s)
 * y se apaga lento (~0.8 s), como una brasa. La runa dorada de Paqo se ADOPTA
 * (`adopt`) para que siga exactamente el mismo comportamiento sin duplicar su
 * malla ni su sitio en la selección de bloom.
 *
 * El aro NO es un TorusGeometry plano como la runa del claro: fuera del claro el
 * terreno se mueve hasta ~2.2 u de un lado al otro del anillo (medido con
 * `field.heightAt` en las nueve repisas), así que un toro rígido quedaría medio
 * enterrado y medio flotando. Se genera un aro que SIGUE el terreno (revolución
 * de una sección circular sobre una directriz muestreada con `heightAt`), a coste
 * despreciable: ~480 tri por aro, build-time, sin texturas.
 *
 * La proximidad se evalúa en el loop del mundo con distancia² en XZ contra una
 * lista estática: sin allocs ni raíces por frame.
 */
export class OracleRings<T extends string = string> {
  readonly group = new THREE.Group();
  private entries: Entry<T>[] = [];
  /**
   * Rampa toon COMPARTIDA por todos los aros. Campo porque `Material.dispose()`
   * no libera texturas: sin referencia la DataTexture quedaría viva en la GPU.
   */
  private ramp?: THREE.DataTexture;

  /** Fade de encendido/apagado (u/s de opacidad): 0.4 s in, 0.8 s out. */
  private static readonly FADE_IN = 1 / 0.4;
  private static readonly FADE_OUT = 1 / 0.8;
  /** Holgura de histéresis del radio de cercanía (u). */
  private static readonly HYSTERESIS = 0.6;
  /** Segmentos de la directriz (a lo largo del aro) y de la sección del tubo. */
  private static readonly ARC_SEGMENTS = 44;
  private static readonly TUBE_SEGMENTS = 6;
  /** Grosor del tubo relativo al radio del aro (la runa de Paqo: 0.26/3.6). */
  private static readonly TUBE_RATIO = 0.072;
  /** Levante sobre el terreno (u): el aro descansa encima del pasto, no dentro. */
  private static readonly LIFT = 0.3;

  constructor(
    private field: IslandField,
    /** Se llama la PRIMERA vez que el jugador entra en el radio de cada aro. */
    private onEnter?: (id: T) => void,
  ) {}

  /** Crea un aro nuevo (lo posee: `dispose()` libera su geometría y material). */
  add(spec: OracleRingSpec<T>): void {
    const tube = spec.radius * OracleRings.TUBE_RATIO;
    const geo = this.ringGeometry(spec.x, spec.z, spec.radius, tube);
    if (!this.ramp) this.ramp = makeToonRamp();
    const mat = new THREE.MeshToonMaterial({
      // Base oscura + emisivo del lore: de día lee como piedra grabada; encendido,
      // como brasa de su color (igual que la runa dorada del claro).
      color: 0x2a2418,
      emissive: new THREE.Color(spec.color),
      emissiveIntensity: 0.6,
      gradientMap: this.ramp,
      transparent: true,
      opacity: 0,
      // Sin escritura de profundidad: el aro se funde sobre el suelo y no pelea
      // con el pasto instanciado al estar a media opacidad.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.field.surfacePoint(spec.x, spec.z));
    mesh.visible = false;
    this.group.add(mesh);
    this.push(spec, mesh, mat, true);
  }

  /**
   * Adopta un aro YA existente (la runa dorada de Paqo): pasa a encenderse por
   * cercanía como los demás. No se libera en `dispose()` — su dueño es quien lo
   * creó. Su material debe venir con `transparent: true` (el fade va por opacidad).
   */
  adopt(mesh: THREE.Mesh, spec: OracleRingSpec<T>): void {
    const mat = mesh.material as THREE.MeshToonMaterial;
    mat.opacity = 0;
    mesh.visible = false;
    this.push(spec, mesh, mat, false);
  }

  private push(spec: OracleRingSpec<T>, mesh: THREE.Mesh, mat: THREE.MeshToonMaterial, owned: boolean): void {
    const far = spec.nearR + OracleRings.HYSTERESIS;
    this.entries.push({
      id: spec.id,
      x: spec.x,
      z: spec.z,
      nearSq: spec.nearR * spec.nearR,
      farSq: far * far,
      mesh,
      mat,
      owned,
      k: 0,
      inside: false,
    });
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /**
   * Aro que sigue el terreno: sección circular de radio `tube` revolucionada
   * sobre una directriz de radio `radius` cuyo Y sale de `field.heightAt`. La
   * geometría es LOCAL al punto de suelo del centro (el mesh se posa ahí), así
   * que el aro se mueve con su mesh sin recalcular nada.
   */
  private ringGeometry(cx: number, cz: number, radius: number, tube: number): THREE.BufferGeometry {
    const A = OracleRings.ARC_SEGMENTS;
    const B = OracleRings.TUBE_SEGMENTS;
    const y0 = this.field.heightAt(cx, cz);
    const pos = new Float32Array(A * B * 3);
    const idx: number[] = [];
    for (let i = 0; i < A; i++) {
      const th = (i / A) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      // Altura de la directriz relativa al centro (+ levante): el aro abraza la cuesta.
      const yc = this.field.heightAt(cx + ct * radius, cz + st * radius) - y0 + OracleRings.LIFT;
      for (let j = 0; j < B; j++) {
        const ph = (j / B) * Math.PI * 2;
        // Sección en el plano (radial, vertical): tubo perpendicular a la directriz.
        const rr = radius + Math.cos(ph) * tube;
        const o = (i * B + j) * 3;
        pos[o] = ct * rr;
        pos[o + 1] = yc + Math.sin(ph) * tube;
        pos[o + 2] = st * rr;
      }
    }
    for (let i = 0; i < A; i++) {
      const i2 = (i + 1) % A;
      for (let j = 0; j < B; j++) {
        const j2 = (j + 1) % B;
        const a = i * B + j;
        const b = i2 * B + j;
        const c = i2 * B + j2;
        const d = i * B + j2;
        idx.push(a, b, c, a, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Barato: distancia² en XZ contra la lista estática. Sin allocs por frame; las
   * escrituras de material sólo ocurren en los aros que están cambiando o vivos.
   * `t` es el tiempo global (pulso de brasa, el mismo que tenía la runa de Paqo).
   */
  update(dt: number, t: number, px: number, pz: number): void {
    const pulse = 0.55 + Math.sin(t * 1.6) * 0.18;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const dx = px - e.x;
      const dz = pz - e.z;
      const d2 = dx * dx + dz * dz;
      // Histéresis: entra en nearSq, sale en farSq (nunca parpadea en el borde).
      if (e.inside ? d2 > e.farSq : d2 <= e.nearSq) {
        e.inside = !e.inside;
        // El evento del quest sólo al ENTRAR; el aro se enciende siempre.
        if (e.inside && e.id) this.onEnter?.(e.id);
      }
      const k = e.inside
        ? Math.min(1, e.k + dt * OracleRings.FADE_IN)
        : Math.max(0, e.k - dt * OracleRings.FADE_OUT);
      if (k !== e.k) {
        e.k = k;
        e.mesh.visible = k > 0.002;
        e.mat.opacity = k;
      }
      if (e.k > 0) e.mat.emissiveIntensity = pulse * e.k;
    }
  }

  dispose(): void {
    for (const e of this.entries) {
      if (!e.owned) continue; // la runa de Paqo la libera PaqoWorld
      e.mesh.geometry.dispose();
      e.mat.dispose();
      this.group.remove(e.mesh);
    }
    this.entries = [];
    this.ramp?.dispose();
    this.ramp = undefined;
    this.group.removeFromParent();
  }
}
