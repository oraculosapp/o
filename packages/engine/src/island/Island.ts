import * as THREE from "three";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { IslandField } from "./IslandField";
import { makeToonRamp, addInvertedHullOutline } from "../util/toon";
import type { BiospherePreset } from "../planet/types";

// Habilita el raycast acelerado por BVH en todas las mallas (opt-in por geo).
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface GroundHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Isla flotante de Paqo:
 * - `mesh`: disco radial de terreno desplazado por IslandField (cel-shading toon
 *   3 bandas con vertex colors por altura/pendiente/claro).
 * - falda de acantilado (banda rocosa vertical bajo el filo) + panza de isla
 *   (cono invertido rocoso facetado con outline inverted-hull) flotando hacia
 *   la niebla.
 * - `hitmesh`: disco low-poly con three-mesh-bvh, invisible, para el tap-to-move.
 */
export class Island {
  readonly field: IslandField;
  readonly mesh: THREE.Mesh;
  readonly hitmesh: THREE.Mesh;
  private extras: THREE.Mesh[] = [];
  private group = new THREE.Group();

  private raycaster = new THREE.Raycaster();

  // Presupuesto: disco visual 240×100 ≈ 48k tris; hitmesh 120×40 ≈ 9.6k tris.
  private static readonly VIS_SPOKES = 240;
  private static readonly VIS_RINGS = 100;
  private static readonly HIT_SPOKES = 120;
  private static readonly HIT_RINGS = 40;

  // Geometría de la isla flotante bajo el filo.
  private static readonly CLIFF_BOTTOM = -14; // base de la falda / arranque de la panza
  private static readonly BELLY_APEX = -74; // punta del cono de la panza
  private static readonly BELLY_INSET = 3; // la panza arranca algo hacia dentro del filo

  constructor(preset: BiospherePreset) {
    this.field = new IslandField(preset);
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;

    this.mesh = this.buildTerrain(preset);
    this.hitmesh = this.buildHitmesh();
    const skirt = this.buildCliffSkirt(preset);
    const belly = this.buildBelly(preset);
    // Outline inverted-hull SOLO en la panza: da silueta oscura nítida a la isla
    // flotante vista de lejos/abajo, sin duplicar los 48k tris del terreno ni
    // provocar z-fighting sobre suelo casi plano.
    addInvertedHullOutline(belly, preset.postFx.outline.color, 1.008);

    this.extras.push(skirt, belly);
    this.group.add(this.mesh, this.hitmesh, skirt, belly);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  // ---- disco radial de terreno ----

  /** Genera un disco radial que sigue la silueta orgánica del filo (edgeRadiusAt). */
  private buildDiscGeometry(spokes: number, rings: number): THREE.BufferGeometry {
    const field = this.field;
    const vCount = 1 + rings * spokes; // 1 centro + anillos
    const positions = new Float32Array(vCount * 3);
    const indices: number[] = [];

    // Centro.
    positions[0] = 0;
    positions[1] = field.heightAt(0, 0);
    positions[2] = 0;

    const idx = (i: number, j: number) => 1 + (i - 1) * spokes + (j % spokes);

    for (let j = 0; j < spokes; j++) {
      const az = (j / spokes) * Math.PI * 2;
      const cx = Math.cos(az);
      const cz = Math.sin(az);
      const edge = field.edgeRadiusAt(cx, cz);
      for (let i = 1; i <= rings; i++) {
        const r = (i / rings) * edge;
        const x = cx * r;
        const z = cz * r;
        const k = idx(i, j) * 3;
        positions[k] = x;
        positions[k + 1] = field.heightAt(x, z);
        positions[k + 2] = z;
      }
    }

    // Abanico central (anillo 1) + quads (anillos 2..rings).
    for (let j = 0; j < spokes; j++) {
      indices.push(0, idx(1, j), idx(1, j + 1));
    }
    for (let i = 1; i < rings; i++) {
      for (let j = 0; j < spokes; j++) {
        const a = idx(i, j);
        const b = idx(i, j + 1);
        const c = idx(i + 1, j + 1);
        const d = idx(i + 1, j);
        indices.push(a, b, d, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  private buildTerrain(preset: BiospherePreset): THREE.Mesh {
    const geo = this.buildDiscGeometry(Island.VIS_SPOKES, Island.VIS_RINGS);
    this.paintVertexColors(geo, preset);
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: makeToonRamp() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "island-terrain";
    return mesh;
  }

  private buildHitmesh(): THREE.Mesh {
    const geo = this.buildDiscGeometry(Island.HIT_SPOKES, Island.HIT_RINGS);
    geo.boundsTree = new MeshBVH(geo);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    mesh.name = "island-hitmesh";
    mesh.visible = false;
    return mesh;
  }

  /** Bandas de color por altura y pendiente, con parche de pradera en el claro. */
  private paintVertexColors(geo: THREE.BufferGeometry, preset: BiospherePreset): void {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);

    const cGround = new THREE.Color(preset.palette.ground); // roca oliva
    const cPrimary = new THREE.Color(preset.palette.primary); // musgo profundo (valles)
    const cSecondary = new THREE.Color(preset.palette.secondary); // salvia (laderas)
    const cMeadow = new THREE.Color(preset.palette.accent); // pradera ácida (claro/planos)
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const flatness = THREE.MathUtils.clamp(nor.getY(i), 0, 1); // 1 = plano, 0 = pared

      const t = THREE.MathUtils.smoothstep(y, 4.5, 10.5);
      c.copy(cPrimary).lerp(cSecondary, t * 0.65);
      const rock = 1 - THREE.MathUtils.smoothstep(flatness, 0.55, 0.82);
      c.lerp(cGround, rock * 0.9);
      const clearing = this.field.clearingMask(x, z);
      const flatMeadow = flatness > 0.96 && y < 1.6 ? 0.3 : 0;
      const meadow = Math.max(clearing, flatMeadow);
      c.lerp(cMeadow, THREE.MathUtils.clamp(meadow, 0, 1) * 0.95);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  // ---- falda de acantilado (banda rocosa vertical bajo el filo) ----

  private buildCliffSkirt(preset: BiospherePreset): THREE.Mesh {
    const spokes = 160;
    const field = this.field;
    const positions: number[] = [];
    const colors: number[] = [];
    const cRock = new THREE.Color(preset.palette.ground).multiplyScalar(0.5);
    const cDark = new THREE.Color(preset.palette.ground).multiplyScalar(0.32);

    const top: THREE.Vector3[] = [];
    const bot: THREE.Vector3[] = [];
    for (let j = 0; j <= spokes; j++) {
      const az = (j / spokes) * Math.PI * 2;
      const cx = Math.cos(az);
      const cz = Math.sin(az);
      const edge = field.edgeRadiusAt(cx, cz);
      const tx = cx * edge;
      const tz = cz * edge;
      const ty = field.heightAt(tx, tz);
      // Base de la falda: hacia dentro y hacia abajo, con dientes rocosos.
      const jag = 0.6 * field.edgeRadiusAt(cx * 1.7 + 3, cz * 1.7) - 0.6 * IslandField.EDGE_BASE;
      const bx = cx * (edge - Island.BELLY_INSET + jag);
      const bz = cz * (edge - Island.BELLY_INSET + jag);
      top.push(new THREE.Vector3(tx, ty, tz));
      bot.push(new THREE.Vector3(bx, Island.CLIFF_BOTTOM + jag * 0.5, bz));
    }
    const pushTri = (a: THREE.Vector3, b: THREE.Vector3, cc: THREE.Vector3, col: THREE.Color) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, cc.x, cc.y, cc.z);
      for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
    };
    const cm = new THREE.Color();
    for (let j = 0; j < spokes; j++) {
      cm.copy(cRock).lerp(cDark, (j % 3) / 3); // veta facetada
      pushTri(top[j], bot[j], bot[j + 1], cm);
      pushTri(top[j], bot[j + 1], top[j + 1], cm);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals(); // non-indexed → facetas planas de roca
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: makeToonRamp() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "island-cliff";
    return mesh;
  }

  // ---- panza de isla flotante (cono invertido rocoso facetado) ----

  private buildBelly(preset: BiospherePreset): THREE.Mesh {
    const spokes = 64; // silueta legible con facetas grandes de roca
    const field = this.field;
    const cRock = new THREE.Color(preset.palette.ground).multiplyScalar(0.42);
    const cDeep = new THREE.Color(preset.palette.ground).multiplyScalar(0.24);

    // Anillo superior de la panza (coincide con la base de la falda).
    const ringTop: THREE.Vector3[] = [];
    for (let j = 0; j <= spokes; j++) {
      const az = (j / spokes) * Math.PI * 2;
      const cx = Math.cos(az);
      const cz = Math.sin(az);
      const edge = field.edgeRadiusAt(cx, cz) - Island.BELLY_INSET;
      ringTop.push(new THREE.Vector3(cx * edge, Island.CLIFF_BOTTOM, cz * edge));
    }
    // Anillos intermedios hacia la punta, con radios irregulares (roca colgante).
    const levels = 4;
    const apex = new THREE.Vector3(0, Island.BELLY_APEX, 0);
    const rings: THREE.Vector3[][] = [ringTop];
    for (let l = 1; l < levels; l++) {
      const tf = l / levels; // 0..1 hacia la punta
      const ring: THREE.Vector3[] = [];
      for (let j = 0; j <= spokes; j++) {
        const base = ringTop[j];
        const az = (j / spokes) * Math.PI * 2;
        // Radio decreciente + protuberancias por nivel (estalactitas de roca).
        const bump = 1 + 0.14 * Math.sin(az * 5 + l * 1.7) * (1 - tf);
        const rad = (1 - tf) * bump;
        const y = THREE.MathUtils.lerp(Island.CLIFF_BOTTOM, Island.BELLY_APEX, tf);
        ring.push(new THREE.Vector3(base.x * rad, y, base.z * rad));
      }
      rings.push(ring);
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const cm = new THREE.Color();
    const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
    };
    for (let l = 0; l < rings.length - 1; l++) {
      const rA = rings[l];
      const rB = rings[l + 1];
      for (let j = 0; j < spokes; j++) {
        cm.copy(cRock).lerp(cDeep, l / rings.length + ((j % 2) * 0.12));
        push(rA[j], rB[j], rB[j + 1], cm);
        push(rA[j], rB[j + 1], rA[j + 1], cm);
      }
    }
    // Punta: fan del último anillo al apex.
    const last = rings[rings.length - 1];
    for (let j = 0; j < spokes; j++) {
      push(last[j], apex, last[j + 1], cDeep);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals(); // facetas planas
    const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: makeToonRamp() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "island-belly";
    return mesh;
  }

  /** Raycast de un rayo arbitrario (cámara) contra el hitmesh. Usado por tap-to-move. */
  raycastFrom(raycaster: THREE.Raycaster): GroundHit | null {
    (raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
    const hits = raycaster.intersectObject(this.hitmesh, false);
    if (hits.length === 0) return null;
    const h = hits[0];
    const normal = h.face
      ? h.face.normal.clone().transformDirection(this.hitmesh.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    return { point: h.point.clone(), normal };
  }

  dispose(): void {
    for (const m of [this.mesh, this.hitmesh, ...this.extras]) {
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat.dispose();
    }
  }
}
