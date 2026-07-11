import * as THREE from "three";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { PlanetField } from "./PlanetField";
import { makeToonRamp, addInvertedHullOutline } from "../util/toon";
import type { BiospherePreset } from "./types";

// Habilita el raycast acelerado por BVH en todas las mallas (opt-in por geo).
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface GroundHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

/**
 * Planeta de Paqo: esfera desplazada con el fBm del preset.
 * - `mesh`: malla visual cel-shading (MeshToonMaterial 3 bandas + outline).
 * - `hitmesh`: versión low-poly (mitad de subdivisiones) con three-mesh-bvh,
 *   invisible, usada por el controller y el tap-to-move para pegar al suelo.
 */
export class Planet {
  readonly field: PlanetField;
  readonly mesh: THREE.Mesh;
  readonly hitmesh: THREE.Mesh;
  private outline: THREE.Mesh;
  private group = new THREE.Group();

  private raycaster = new THREE.Raycaster();
  private _origin = new THREE.Vector3();
  private _dir = new THREE.Vector3();

  // Presupuesto: detail 6 = 81 920 tris visual; hitmesh detail 5 = 20 480 tris.
  static readonly RADIUS = 40;
  private static readonly VISUAL_DETAIL = 6;
  private static readonly HIT_DETAIL = 5;

  constructor(preset: BiospherePreset, radius = Planet.RADIUS) {
    this.field = new PlanetField(preset, radius);
    // El raycaster sólo devuelve el primer impacto → mucho más rápido con BVH.
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;

    this.mesh = this.buildVisual(preset);
    this.outline = addInvertedHullOutline(this.mesh, preset.postFx.outline.color, 1.015);
    this.hitmesh = this.buildHitmesh();

    this.group.add(this.mesh);
    this.group.add(this.hitmesh);
  }

  /** Añade el planeta (visual + hitmesh) a la escena. */
  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  private buildVisual(preset: BiospherePreset): THREE.Mesh {
    const geo = new THREE.IcosahedronGeometry(this.field.radius, Planet.VISUAL_DETAIL);
    this.field.displace(geo);
    this.paintVertexColors(geo, preset);

    const mat = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: makeToonRamp(),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "planet-visual";
    return mesh;
  }

  private buildHitmesh(): THREE.Mesh {
    const geo = new THREE.IcosahedronGeometry(this.field.radius, Planet.HIT_DETAIL);
    this.field.displace(geo);
    geo.boundsTree = new MeshBVH(geo);

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    mesh.name = "planet-hitmesh";
    mesh.visible = false; // no se pinta, pero sí participa en raycasts explícitos
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

    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const c = new THREE.Color();
    const R = this.field.radius;

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const h = v.length() - R; // altura sobre el radio base
      dir.copy(v).normalize();
      n.fromBufferAttribute(nor, i);
      // Pendiente: 1 = plano (normal alineada al radio), 0 = pared vertical.
      const flatness = THREE.MathUtils.clamp(n.dot(dir), 0, 1);

      // Base: musgo profundo domina; salvia sólo asoma en cimas altas.
      const t = THREE.MathUtils.smoothstep(h, 4.5, 10.5);
      c.copy(cPrimary).lerp(cSecondary, t * 0.65);
      // Roca oliva en pendientes (laderas del anfiteatro y crestas).
      const rock = 1 - THREE.MathUtils.smoothstep(flatness, 0.55, 0.82);
      c.lerp(cGround, rock * 0.9);
      // Pradera ácida SOLO en el claro y en llanos casi perfectos y bajos —
      // fuera del claro dominan primary/ground para que el claro destaque.
      const clearing = this.field.clearingMask(dir);
      const flatMeadow = flatness > 0.96 && h < 1.6 ? 0.3 : 0;
      const meadow = Math.max(clearing, flatMeadow);
      c.lerp(cMeadow, THREE.MathUtils.clamp(meadow, 0, 1) * 0.95);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Raycast contra el hitmesh a lo largo de -up desde encima de `from`.
   * Devuelve punto y normal del suelo, o null si no golpea.
   */
  sampleGround(from: THREE.Vector3, up: THREE.Vector3, probe = 12): GroundHit | null {
    this._origin.copy(up).multiplyScalar(probe).add(from);
    this._dir.copy(up).multiplyScalar(-1).normalize();
    this.raycaster.set(this._origin, this._dir);
    this.raycaster.far = probe * 3;
    const hits = this.raycaster.intersectObject(this.hitmesh, false);
    if (hits.length === 0) return null;
    const h = hits[0];
    const normal = h.face
      ? h.face.normal.clone().transformDirection(this.hitmesh.matrixWorld)
      : up.clone();
    return { point: h.point.clone(), normal };
  }

  /**
   * Raycast de un rayo arbitrario (p.ej. desde la cámara) contra el hitmesh.
   * Usado por tap-to-move. `raycaster` ya debe venir configurado (setFromCamera).
   */
  raycastFrom(raycaster: THREE.Raycaster): GroundHit | null {
    (raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
    const hits = raycaster.intersectObject(this.hitmesh, false);
    if (hits.length === 0) return null;
    const h = hits[0];
    const normal = h.face
      ? h.face.normal.clone().transformDirection(this.hitmesh.matrixWorld)
      : h.point.clone().normalize();
    return { point: h.point.clone(), normal };
  }

  dispose(): void {
    for (const m of [this.mesh, this.hitmesh, this.outline]) {
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat.dispose();
    }
  }
}
