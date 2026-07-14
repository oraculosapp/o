import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";
import { makeToonRamp } from "../util/toon";
import { mulberry32 } from "./rng";

type WindUniform = { value: number };

// ============================================================================
// [EQUIPO FLORA] CONTEO Y DENSIDAD — knobs para la ronda de arte.
// Poblamos TODA la isla (claro r≈5 → filo orgánico r≈49..63) por ANILLOS
// concéntricos: densidad plena cerca del tótem, decae hacia el filo y usa
// geometría más barata lejos (LOD). El área r≤56 es ~5.4× la de r≤24, pero NO
// escalamos 5× "a lo bruto": los anillos de densidad + el LOD + el fog exp2 de
// la escena hacen el trabajo pesado. Todo procedural, sin texturas ni deps.
// ============================================================================

/** Filo base de la isla (espejo de IslandField.EDGE_BASE, solo para muestreo). */
const ISLAND_EDGE_BASE = 56;

/**
 * Pasto por anillos (radios en u de mundo). Cada anillo = 1 InstancedMesh.
 * `target` = hojas a posar (se reintenta hasta alcanzarlo o agotar el guard);
 * el conteo real se reporta en build. Total objetivo ~40–55k en 3 draw calls.
 */
const GRASS_RINGS = [
  // cercano: pradera densa que abraza el claro/tótem (sensación actual, +un pelín).
  { rMin: 5, rMax: 26, target: 16000, detailed: true, align: 0.7, edgeLimited: false },
  // medio: ~60% densidad, misma hoja detallada, alineación más suave.
  { rMin: 26, rMax: 42, target: 15500, detailed: true, align: 0.5, edgeLimited: false },
  // lejano: ~35% densidad, hoja BARATA (cruz de 2 quads), vertical, hasta filo−margen.
  { rMin: 42, rMax: 58, target: 11000, detailed: false, align: 0.0, edgeLimited: true },
] as const;
/** El anillo lejano se detiene a `edgeRadiusAt(x,z) − margen` (no cuelga del filo). */
const GRASS_EDGE_MARGIN = 3;
/**
 * Tolerancia de voladizo del pasto (u): cuánto puede sobresalir la huella de la
 * base sobre una convexidad del terreno antes de rechazar. Las hojas son diminutas
 * y toon; una tolerancia pequeña (en vez de ~0 en la esfera) evita rechazar casi
 * todo el pasto sobre el terreno ondulado/ridged de la isla entera.
 */
const GRASS_OVERHANG_TOL = 0.14;
/** Tope de intentos por anillo = target × este factor (corta si el anillo se satura). */
const GRASS_TRIES_FACTOR = 7;

// Conteos base de las demás piezas (~×3 de la versión "solo centro" para cubrir
// la isla entera). Se multiplican por la densidad del preset dentro de cada build,
// así los knobs de arte (paqo.json) siguen mandando y aterrizamos en ~3×.
const TREE_COUNT = 210; // × trees.density (~0.35 → ~73 árboles)
const FERN_COUNT = 620; // × shrubs.density (~0.4 → ~248 helechos)
const SHRUB_COUNT = 400; // × shrubs.density (~0.4 → ~160 matas)
const FLOWER_COUNT = 2600; // × flowers.density (~0.15 → ~390 flores)
const ROCK_SCATTER = 120; // × rockScatter.density (~0.3 → ~36) + menhires
const MENHIR_COUNT = 6; // menhires altos repartidos (era 4)
const CLUMP_ANCHORS = 46; // anclas de agrupación por TODA la isla (era 16)

// Corredores del cañón (±X): mantenerlos transitables. Los árboles densos evitan
// la franja angular alrededor de ±X en el rango radial de los pasos.
const CANYON_HALF_ANGLE = 0.5; // rad (~±28°, algo más ancho que IslandField.gateSigma)
const CANYON_R_MIN = 12;
const CANYON_R_MAX = 52;

/**
 * Vegetación instanciada del valle de Paqo (isla flotante), fiel a la ficha:
 * pasto alto denso (cards con viento en shader), árboles "guardianes" retorcidos
 * agrupados en los bordes (con musgo colgante), helechos y flores en el claro, y
 * rocas-menhir musgosas.
 *
 * Todo se posa con la MISMA IslandField.heightAt (única fuente de verdad de la
 * forma del terreno) en coordenadas planas XZ, y conserva TODAS las reglas
 * ganadas en la esfera: hundir bases, alinear a la pendiente, umbral de 40°,
 * exclusión del claro y del cono de visión spawn→tótem, anclas de agrupación.
 * Pocas draw calls: 1 InstancedMesh por pieza.
 */
export class Vegetation {
  readonly group = new THREE.Group();
  /** Tiempo compartido por TODOS los materiales con viento (una escritura/frame). */
  private windTime: WindUniform = { value: 0 };
  /** Escala global de amplitud del viento (setWindScale): 1 = normal; tormenta 0.7–2.4. */
  private windScale: WindUniform = { value: 1 };
  private meshes: THREE.InstancedMesh[] = [];
  private ramp = makeToonRamp();

  /** Conteos finales por pieza/anillo (para el reporte de build). */
  private grassCounts: number[] = [];
  private counts: Record<string, number> = {};

  private readonly excludeRadius = 5; // u libres alrededor del tótem (origen)
  /** Pendiente máxima (rad) donde aún se planta pasto alto (~40°). */
  private static readonly MAX_GRASS_SLOPE = THREE.MathUtils.degToRad(40);

  // Trabajo reutilizable.
  private _pt = new THREE.Vector2();
  private _pos = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _up = new THREE.Vector3();
  private _nrm = new THREE.Vector3();
  private _s = new THREE.Vector3();
  private _m = new THREE.Matrix4();
  private _yaw = new THREE.Quaternion();
  private _corner = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
    /** Posición de spawn (XZ): define el cono de visión spawn→tótem libre de rocas. */
    private spawnPos = new THREE.Vector3(0, 0, 7),
  ) {}

  build(): void {
    const hasPerf = typeof performance !== "undefined";
    const t0 = hasPerf ? performance.now() : 0;
    const rand = mulberry32(0x9a3c1);
    this.buildGrass(rand);
    const clumps = this.clumpAnchors(rand, CLUMP_ANCHORS);
    this.buildShrubs(rand, clumps);
    this.buildFerns(rand, clumps);
    this.buildFlowers(rand);
    this.buildTrees(rand);
    this.buildRocks(rand);
    if (hasPerf) {
      const ms = performance.now() - t0;
      const grass = this.grassCounts.reduce((a, b) => a + b, 0);
      console.debug(
        `[EQUIPO FLORA] Vegetation.build ${ms.toFixed(1)}ms — pasto ${grass} (${this.grassCounts.join(
          "+",
        )}) · ${Object.entries(this.counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")} · draw calls ${this.meshes.length}`,
      );
    }
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(_dt: number, t: number): void {
    this.windTime.value = t;
  }

  /**
   * Escala global de la amplitud del viento sobre TODO material con windShader
   * (pasto de los 3 anillos, helechos, matas, flores, musgo). Un único uniform
   * compartido `uWindScale` (default 1); Atmos lo empuja a 0.7–2.4 en tormenta.
   */
  setWindScale(s: number): void {
    this.windScale.value = s;
  }

  // ---- helpers de colocación ----

  /** Punto (x,z) uniforme en área dentro de un anillo alrededor del origen. */
  private randAnnulus(rand: () => number, minR: number, maxR: number): THREE.Vector2 {
    const r = Math.sqrt(minR * minR + (maxR * maxR - minR * minR) * rand());
    const a = rand() * Math.PI * 2;
    return this._pt.set(Math.cos(a) * r, Math.sin(a) * r);
  }

  /**
   * Excedente máximo (u) con que la huella de la base (±halfW) queda POR ENCIMA
   * del terreno tras aplicar `m`. Detecta esquinas en voladizo sobre crestas del
   * ruido ridged para hundirlas. Solo build-time.
   */
  private footprintOverhang(m: THREE.Matrix4, halfW: number): number {
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      this._corner.set(
        k === 0 ? halfW : k === 1 ? -halfW : 0,
        0,
        k === 2 ? halfW : k === 3 ? -halfW : 0,
      );
      this._corner.applyMatrix4(m);
      const above = this._corner.y - this.field.heightAt(this._corner.x, this._corner.z);
      if (above > worst) worst = above;
    }
    return worst;
  }

  /**
   * Matriz de instancia: posa (x,z) en el suelo con yaw y escala. `align` mezcla
   * el up entre vertical puro (0) y la normal real del terreno (1): con ~0.6-0.7
   * las plantas acompañan la cuesta y su base muerde la ladera. `sink` hunde la
   * base a lo largo del up resultante.
   */
  private placeMatrix(
    x: number,
    z: number,
    yaw: number,
    scale: THREE.Vector3,
    sink = 0,
    out = new THREE.Matrix4(),
    align = 0,
  ): THREE.Matrix4 {
    this._pos.set(x, this.field.heightAt(x, z), z);
    if (align > 0) {
      this.field.surfaceNormal(x, z, this._nrm);
      this._up.copy(Vegetation.UP).multiplyScalar(1 - align).addScaledVector(this._nrm, align).normalize();
    } else {
      this._up.copy(Vegetation.UP);
    }
    this._pos.addScaledVector(this._up, -sink);
    this._q.setFromUnitVectors(Vegetation.UP, this._up);
    this._yaw.setFromAxisAngle(this._up, yaw);
    this._q.premultiply(this._yaw);
    out.compose(this._pos, this._q, scale);
    return out;
  }

  /**
   * Anclas de agrupación repartidas por TODA la isla (del borde del claro al
   * filo): donde se agolpan helechos y matas. Muestreo área-uniforme + rechazo
   * fuera de isla / dentro del claro, con un margen al filo para no colgar.
   */
  private clumpAnchors(rand: () => number, n: number): THREE.Vector2[] {
    const anchors: THREE.Vector2[] = [];
    const minR = Math.max(11, this.excludeRadius);
    let guard = 0;
    while (anchors.length < n && guard++ < n * 24) {
      const p = this.randAnnulus(rand, minR, ISLAND_EDGE_BASE - 4);
      const r = Math.hypot(p.x, p.y);
      if (r > this.field.edgeRadiusAt(p.x, p.y) - 4) continue;
      if (this.field.clearingMask(p.x, p.y) > 0.25) continue;
      anchors.push(p.clone());
    }
    return anchors;
  }

  // (Los constructores de geometría son idénticos a la versión esférica.)

  private fernFrond(seed: number): THREE.BufferGeometry {
    const S = 2;
    const Ls = 0.82 + seed * 0.28;
    const maxBend = 2.05 + seed * 0.5;
    const r = Ls / maxBend;
    const w0 = 0.09;
    const secC: THREE.Vector3[] = [];
    const secL: THREE.Vector3[] = [];
    const secR: THREE.Vector3[] = [];
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      const ang = t * maxBend;
      const x = r * (1 - Math.cos(ang));
      const y = r * Math.sin(ang);
      const w = w0 * Math.pow(1 - t, 0.6);
      const dip = w * 0.55;
      secC.push(new THREE.Vector3(x, y, 0));
      secL.push(new THREE.Vector3(x, y - dip, w));
      secR.push(new THREE.Vector3(x, y - dip, -w));
    }
    const pos: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < S; i++) {
      push(secC[i], secL[i], secL[i + 1]);
      push(secC[i], secL[i + 1], secC[i + 1]);
      push(secC[i], secC[i + 1], secR[i + 1]);
      push(secC[i], secR[i + 1], secR[i]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return geo;
  }

  private fernPlant(): THREE.BufferGeometry {
    const fronds = 6;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < fronds; i++) {
      const f = this.fernFrond((i * 0.618) % 1);
      f.rotateY((i / fronds) * Math.PI * 2 + i * 0.4);
      parts.push(f);
    }
    const merged = mergeGeometries(parts, false)!;
    parts.forEach((p) => p.dispose());
    merged.computeVertexNormals();
    return merged;
  }

  private flowerStem(h: number): THREE.BufferGeometry {
    const geo = new THREE.CylinderGeometry(0.012, 0.02, h, 3, 1).toNonIndexed();
    geo.translate(0, h / 2, 0);
    geo.computeVertexNormals();
    return geo;
  }

  private flowerCorolla(atY: number): THREE.BufferGeometry {
    const petals = 6;
    const rad = 0.085;
    const rise = 0.075;
    const apex = new THREE.Vector3(0, atY + rise, 0);
    const pos: number[] = [];
    for (let i = 0; i < petals; i++) {
      const a0 = (i / petals) * Math.PI * 2;
      const a1 = ((i + 1) / petals) * Math.PI * 2;
      const p0 = new THREE.Vector3(Math.cos(a0) * rad, atY, Math.sin(a0) * rad);
      const p1 = new THREE.Vector3(Math.cos(a1) * rad, atY, Math.sin(a1) * rad);
      pos.push(apex.x, apex.y, apex.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  private shrubBlob(): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(0.6, 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(pos, i);
      const bump = 0.82 + 0.32 * Math.sin(n.x * 5.1 + n.y * 3.3) * Math.cos(n.z * 4.7 + 1.2);
      pos.setXYZ(i, n.x * bump, n.y * bump * 0.62, n.z * bump);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  private mossCone(): THREE.BufferGeometry {
    const geo = new THREE.ConeGeometry(0.22, 1.0, 5, 2, true).toNonIndexed();
    geo.translate(0, 0.5, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const k = 1 - v.y;
      const j = 0.14 * Math.sin(v.y * 7.3 + i * 1.1);
      pos.setXYZ(i, v.x * (0.7 + 0.5 * k) + j, v.y, v.z * (0.7 + 0.5 * k) - j);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  private upNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
    nor.needsUpdate = true;
    return geo;
  }

  private bladeCross(w: number, h: number): THREE.BufferGeometry {
    const half = w / 2;
    const midY = h * 0.55;
    const midX = half * 0.38;
    const face = new THREE.BufferGeometry();
    face.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-half, 0, 0, half, 0, 0, -midX, midY, 0, midX, midY, 0, 0, h, 0],
        3,
      ),
    );
    face.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.3, 0.55, 0.7, 0.55, 0.5, 1], 2),
    );
    face.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    face.computeVertexNormals();
    const other = face.clone();
    other.rotateY(Math.PI / 2);
    const merged = mergeGeometries([face, other], false)!;
    face.dispose();
    other.dispose();
    return merged;
  }

  /**
   * Hoja BARATA para el anillo lejano: dos quads verticales cruzados (8 vért,
   * 4 tri) en vez del bladeCross detallado (10 vért, 6 tri). El fog + la lejanía
   * ocultan la simplicidad; el ahorro de vértices ×miles de instancias cuenta.
   */
  private bladeQuadCross(w: number, h: number): THREE.BufferGeometry {
    const half = w / 2;
    const quad = new THREE.BufferGeometry();
    quad.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-half, 0, 0, half, 0, 0, -half, h, 0, half, h, 0], 3),
    );
    quad.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    quad.setIndex([0, 1, 2, 2, 1, 3]);
    quad.computeVertexNormals();
    const other = quad.clone();
    other.rotateY(Math.PI / 2);
    const merged = mergeGeometries([quad, other], false)!;
    quad.dispose();
    other.dispose();
    return merged;
  }

  private windShader(mat: THREE.MeshToonMaterial, height: number, amp: number): void {
    mat.onBeforeCompile = (shader) => {
      // Uniforms COMPARTIDOS por referencia: una escritura mueve todo el viento.
      shader.uniforms.uTime = this.windTime;
      shader.uniforms.uWindScale = this.windScale;
      shader.uniforms.uWindH = { value: height };
      shader.uniforms.uWindAmp = { value: amp };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform float uTime; uniform float uWindH; uniform float uWindAmp; uniform float uWindScale;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             vec3 iPos = instanceMatrix[3].xyz;
             float ph = iPos.x * 0.7 + iPos.z * 0.9;
           #else
             float ph = 0.0;
           #endif
           float h01 = clamp(position.y / uWindH, 0.0, 1.0);
           float bend = h01 * h01;
           float sway = sin(uTime * 1.4 + ph) * 0.18 + sin(uTime * 2.7 + ph * 1.7) * 0.06;
           float wAmp = uWindAmp * uWindScale;
           transformed.x += sway * bend * wAmp;
           transformed.z += cos(uTime * 1.05 + ph) * 0.10 * bend * wAmp;`,
        );
    };
    mat.needsUpdate = true;
  }

  private registerMesh(mesh: THREE.InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  // ---- pasto ----

  private buildGrass(rand: () => number): void {
    for (const ring of GRASS_RINGS) this.buildGrassRing(rand, ring);
  }

  /**
   * Posa un anillo de pasto (1 InstancedMesh). Optimización clave: la normal del
   * terreno se muestrea UNA sola vez por candidato y de ahí salen tanto la
   * pendiente (rechazo) como el `up` de alineación — evita el doble muestreo de
   * heightAt (slopeAt + placeMatrix) de la versión previa. El anillo lejano usa
   * hoja barata, sin alineación ni chequeo de voladizo (fog + lejanía perdonan).
   */
  private buildGrassRing(
    rand: () => number,
    ring: { rMin: number; rMax: number; target: number; detailed: boolean; align: number; edgeLimited: boolean },
  ): void {
    const g = this.preset.vegetation?.grass ?? {};
    const height = g.height ?? 1.4;
    const geo = ring.detailed
      ? this.upNormals(this.bladeCross(0.16, height))
      : this.upNormals(this.bladeQuadCross(0.14, height));
    const mat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide,
      alphaTest: 0.0,
    });
    this.windShader(mat, height, g.windSway ?? 0.6);

    const mesh = new THREE.InstancedMesh(geo, mat, ring.target);
    const cAccent = new THREE.Color(this.preset.palette.accent);
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const cDeep = new THREE.Color(this.preset.palette.primary);
    const col = new THREE.Color();
    const maxSlope = Vegetation.MAX_GRASS_SLOPE;

    // Se reintenta hasta alcanzar `target` o agotar el guard (satura → corta y
    // reporta lo posado, sin colgarse). Coste dominado por heightAt (fBm); el
    // guard acota el peor caso.
    let placed = 0;
    let tries = 0;
    const maxTries = ring.target * GRASS_TRIES_FACTOR;
    while (placed < ring.target && tries++ < maxTries) {
      const p = this.randAnnulus(rand, ring.rMin, ring.rMax);
      const x = p.x;
      const z = p.y;
      // Filo orgánico: el anillo lejano no rebasa `edgeRadiusAt − margen` (barato,
      // antes que cualquier heightAt).
      if (ring.edgeLimited && Math.hypot(x, z) > this.field.edgeRadiusAt(x, z) - GRASS_EDGE_MARGIN)
        continue;
      const mask = this.field.clearingMask(x, z);
      const inClearing = mask > 0.4;
      if (inClearing && rand() > 0.3) continue;
      // Normal UNA vez → pendiente + up de alineación.
      this.field.surfaceNormal(x, z, this._nrm);
      if (Math.acos(THREE.MathUtils.clamp(this._nrm.y, -1, 1)) > maxSlope) continue;
      const sc = 0.7 + rand() * 0.6;
      const ySc = inClearing ? 0.22 + rand() * 0.07 : 0.85 + rand() * 0.4;
      this._s.set(sc, ySc, sc);
      const sink = 0.06 + 0.05 * sc;
      // Compón la matriz reutilizando la normal ya calculada (sin re-muestrear).
      this._pos.set(x, this.field.heightAt(x, z), z);
      if (ring.align > 0) {
        this._up
          .copy(Vegetation.UP)
          .multiplyScalar(1 - ring.align)
          .addScaledVector(this._nrm, ring.align)
          .normalize();
      } else {
        this._up.copy(Vegetation.UP);
      }
      this._pos.addScaledVector(this._up, -sink);
      this._q.setFromUnitVectors(Vegetation.UP, this._up);
      this._yaw.setFromAxisAngle(this._up, rand() * Math.PI * 2);
      this._q.premultiply(this._yaw);
      this._m.compose(this._pos, this._q, this._s);
      if (ring.detailed && this.footprintOverhang(this._m, 0.08) > GRASS_OVERHANG_TOL) continue;
      mesh.setMatrixAt(placed, this._m);
      col.copy(cSage).lerp(cAccent, inClearing ? 0.45 + rand() * 0.4 : rand() * 0.7);
      if (!inClearing && rand() < 0.25) col.lerp(cDeep, 0.4);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
    this.grassCounts.push(placed);
  }

  // ---- helechos ----

  private buildFerns(rand: () => number, clumps: THREE.Vector2[]): void {
    const s = this.preset.vegetation?.shrubs;
    const count = Math.round(FERN_COUNT * (s?.density ?? 0.4));
    const geo = this.fernPlant();
    const mat = new THREE.MeshToonMaterial({ gradientMap: this.ramp, side: THREE.DoubleSide });
    this.windShader(mat, 0.4, 0.28);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const cAccent = new THREE.Color(this.preset.palette.accent);
    const col = new THREE.Color();

    // Cuelgan de las anclas (repartidas por toda la isla): se elige un ancla al
    // azar por intento hasta llenar el conteo, así la cobertura no depende del nº
    // de anclas y el bosquecillo respira alrededor de cada una.
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8 && clumps.length > 0) {
      const anchor = clumps[(rand() * clumps.length) | 0];
      const rr = rand() * 1.8;
      const ang = rand() * Math.PI * 2;
      const x = anchor.x + Math.cos(ang) * rr;
      const z = anchor.y + Math.sin(ang) * rr;
      if (this.field.clearingMask(x, z) > 0.3) continue;
      const yaw = rand() * Math.PI * 2;
      const sc = 0.85 + rand() * 0.7;
      this._s.set(sc, sc * (0.85 + rand() * 0.35), sc);
      const sink = 0.05 + 0.05 * sc;
      mesh.setMatrixAt(placed, this.placeMatrix(x, z, yaw, this._s, sink, this._m, 0.65));
      col.copy(cSage).lerp(cAccent, 0.2 + rand() * 0.45);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
    this.counts.helechos = placed;
  }

  // ---- matas / arbustos ----

  private buildShrubs(rand: () => number, clumps: THREE.Vector2[]): void {
    const s = this.preset.vegetation?.shrubs;
    const count = Math.round(SHRUB_COUNT * (s?.density ?? 0.4));
    const geo = this.shrubBlob();
    const mat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    this.windShader(mat, 0.5, 0.12);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const cDeep = new THREE.Color(this.preset.palette.primary);
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const col = new THREE.Color();
    const sizes = [0.75, 1.05, 1.5];

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8 && clumps.length > 0) {
      const anchor = clumps[(rand() * clumps.length) | 0];
      const rr = rand() * 2.2;
      const ang = rand() * Math.PI * 2;
      const x = anchor.x + Math.cos(ang) * rr;
      const z = anchor.y + Math.sin(ang) * rr;
      if (this.field.clearingMask(x, z) > 0.25) continue;
      const base = sizes[(rand() * sizes.length) | 0];
      const yaw = rand() * Math.PI * 2;
      this._s.set(base * (0.9 + rand() * 0.2), base * (0.85 + rand() * 0.3), base * (0.9 + rand() * 0.2));
      mesh.setMatrixAt(placed, this.placeMatrix(x, z, yaw, this._s, base * 0.26, this._m, 0.6));
      col.copy(cDeep).lerp(cSage, 0.35 + rand() * 0.4);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
    this.counts.matas = placed;
  }

  // ---- flores ----

  private buildFlowers(rand: () => number): void {
    const f = this.preset.vegetation?.flowers;
    const count = Math.round(FLOWER_COUNT * (f?.density ?? 0.15));
    const stemH = 0.22;
    const stemGeo = this.flowerStem(stemH);
    const corGeo = this.flowerCorolla(stemH);
    const stemMat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      color: new THREE.Color(this.preset.palette.primary).lerp(
        new THREE.Color(this.preset.palette.secondary),
        0.4,
      ),
    });
    const corMat = new THREE.MeshToonMaterial({ gradientMap: this.ramp, side: THREE.DoubleSide });
    this.windShader(stemMat, stemH + 0.075, 0.22);
    this.windShader(corMat, stemH + 0.075, 0.22);
    const stems = new THREE.InstancedMesh(stemGeo, stemMat, count);
    const corollas = new THREE.InstancedMesh(corGeo, corMat, count);
    const palette = (f?.colors?.length ? f.colors : ["#E8ECEA", "#E67E22"]).map(
      (c) => new THREE.Color(c),
    );
    const col = new THREE.Color();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8) {
      // Matas de flores por TODA la isla (del borde del claro al filo). Evita el
      // centro pelado del claro (mask>0.9) y el filo (para no colgar del vacío).
      const center = this.randAnnulus(rand, Math.max(9, this.excludeRadius), ISLAND_EDGE_BASE - 6).clone();
      const cr = Math.hypot(center.x, center.y);
      if (cr > this.field.edgeRadiusAt(center.x, center.y) - 5) continue;
      const mask = this.field.clearingMask(center.x, center.y);
      if (mask > 0.9) continue;
      const clusterColor = palette[(rand() * palette.length) | 0];
      const mixed = rand() < 0.3;
      const clusterSize = 3 + ((rand() * 3) | 0);
      for (let k = 0; k < clusterSize && placed < count; k++) {
        const rr = rand() * 0.5;
        const a = rand() * Math.PI * 2;
        const x = center.x + Math.cos(a) * rr;
        const z = center.y + Math.sin(a) * rr;
        const yaw = rand() * Math.PI * 2;
        const sc = 0.75 + rand() * 0.5;
        this._s.set(sc, sc, sc);
        this.placeMatrix(x, z, yaw, this._s, 0.025 + 0.025 * sc, this._m, 0.65);
        stems.setMatrixAt(placed, this._m);
        corollas.setMatrixAt(placed, this._m);
        col.copy(mixed ? palette[(rand() * palette.length) | 0] : clusterColor);
        if (k % 2 === 1) col.lerp(new THREE.Color(0xffffff), 0.3);
        corollas.setColorAt(placed, col);
        placed++;
      }
    }
    stems.count = placed;
    corollas.count = placed;
    if (corollas.instanceColor) corollas.instanceColor.needsUpdate = true;
    this.registerMesh(stems);
    this.registerMesh(corollas);
    this.counts.flores = placed;
  }

  /**
   * ¿(x,z) cae en un corredor del cañón (±X)? Se usa para NO plantar árboles
   * densos y mantener los dos pasos transitables (el check de pendiente ayuda,
   * pero los troncos taparían la salida). Réplica ligera del gateMask privado de
   * IslandField: franja angular alrededor de ±X en el rango radial de los pasos.
   */
  private inCanyonCorridor(x: number, z: number): boolean {
    const r = Math.hypot(x, z);
    if (r < CANYON_R_MIN || r > CANYON_R_MAX) return false;
    const az = Math.atan2(z, x);
    const d0 = Math.abs(Math.atan2(Math.sin(az), Math.cos(az))); // dist angular a +X
    const d1 = Math.abs(Math.atan2(Math.sin(az - Math.PI), Math.cos(az - Math.PI))); // a −X
    return Math.min(d0, d1) < CANYON_HALF_ANGLE;
  }

  // ---- árboles guardianes + musgo colgante ----

  private buildTrees(rand: () => number): void {
    const tp = this.preset.vegetation?.trees;
    const treeCount = Math.round(TREE_COUNT * (tp?.density ?? 0.35));
    const maxTreeSlope = THREE.MathUtils.degToRad(45);

    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.34, 2.6, 6, 3).toNonIndexed();
    trunkGeo.translate(0, 1.3, 0);
    trunkGeo.computeVertexNormals();
    const blobGeo = new THREE.IcosahedronGeometry(1.0, 1);
    blobGeo.computeVertexNormals();

    const trunkMat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    const canopyMat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    const mossMat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    this.windShader(mossMat, 1.0, 0.45);

    const blobsPerTree = 3;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const canopy = new THREE.InstancedMesh(blobGeo, canopyMat, treeCount * blobsPerTree);
    const mossGeo = this.mossCone();
    const moss = new THREE.InstancedMesh(mossGeo, mossMat, treeCount * 2);

    const cBark = new THREE.Color(this.preset.palette.ground).multiplyScalar(0.75);
    const cLeafA = new THREE.Color(this.preset.palette.primary);
    const cLeafB = new THREE.Color(this.preset.palette.secondary);
    const cMoss = new THREE.Color(this.preset.palette.secondary).lerp(new THREE.Color(0xbfcbb6), 0.5);
    const col = new THREE.Color();

    let ti = 0;
    let ci = 0;
    let mi = 0;
    let guard = 0;
    const clusterAtEdges = tp?.clusterAtEdges !== false;
    while (ti < treeCount && guard++ < treeCount * 10) {
      // Guardianes que ABRAZAN el filo de la isla (bosquecillos sobre el acantilado
      // — dramático con la caída al vacío), más algunos bosquetes interiores.
      const az = rand() * Math.PI * 2;
      let x: number;
      let z: number;
      if (clusterAtEdges && rand() < 0.7) {
        // edgeRadiusAt sólo depende del azimut (normaliza dentro): eval en el rayo.
        const edge = this.field.edgeRadiusAt(Math.cos(az), Math.sin(az));
        const r = edge - (2 + rand() * 11); // 2..13 u tierra adentro del filo
        x = Math.cos(az) * r;
        z = Math.sin(az) * r;
      } else {
        const r = 12 + rand() * 34; // bosquete interior repartido
        x = Math.cos(az) * r;
        z = Math.sin(az) * r;
      }
      if (!this.field.insideIsland(x, z)) continue;
      if (this.field.clearingMask(x, z) > 0.25) continue;
      // Corredores del cañón: densidad muy baja (deja los pasos transitables).
      if (this.inCanyonCorridor(x, z) && rand() < 0.85) continue;
      // Nada de guardianes colgando de paredes de acantilado.
      if (this.field.slopeAt(x, z) > maxTreeSlope) continue;
      const yaw = rand() * Math.PI * 2;
      const scale = 1.4 + rand() * 1.3;
      const lean = 0.12 + rand() * 0.14;

      // Tronco radial-vertical con leve inclinación (twist gnarled).
      this._pos.set(x, this.field.heightAt(x, z) - 0.2, z);
      this._up.copy(Vegetation.UP);
      this._q.setFromUnitVectors(Vegetation.UP, this._up);
      this._yaw.setFromAxisAngle(this._up, yaw);
      this._q.premultiply(this._yaw);
      const tilt = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)),
        lean,
      );
      this._q.multiply(tilt);
      this._s.set(scale, scale, scale);
      this._m.compose(this._pos, this._q, this._s);
      trunks.setMatrixAt(ti, this._m);
      col.copy(cBark).multiplyScalar(0.85 + rand() * 0.3);
      trunks.setColorAt(ti, col);

      for (let b = 0; b < blobsPerTree; b++) {
        const off = new THREE.Vector3((rand() - 0.5) * 1.3, 2.4 + rand() * 1.1, (rand() - 0.5) * 1.3);
        const bScale = (0.9 + rand() * 0.7) * scale * 0.85;
        const worldOff = off.clone().applyQuaternion(this._q).multiplyScalar(scale * 0.6);
        this._s.set(bScale, bScale * (0.8 + rand() * 0.3), bScale);
        this._m.compose(
          this._pos.clone().add(worldOff),
          this._q.clone().multiply(
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI),
          ),
          this._s,
        );
        canopy.setMatrixAt(ci, this._m);
        col.copy(cLeafA).lerp(cLeafB, rand() * 0.6);
        canopy.setColorAt(ci, col);
        ci++;
      }

      if (tp?.mossHang !== false && rand() < 0.6 && mi < moss.count) {
        const lateral = new THREE.Vector3((rand() - 0.5) * 1.4, 0, (rand() - 0.5) * 1.4)
          .applyQuaternion(this._q)
          .multiplyScalar(scale * 0.6);
        const attach = this._pos.clone().addScaledVector(this._up, scale * 1.7).add(lateral);
        const down = this._up.clone().negate();
        const qMoss = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), down);
        qMoss.multiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2),
        );
        const len = scale * (0.8 + rand() * 0.5);
        this._s.set(scale * 0.7, len, scale * 0.7);
        this._m.compose(attach, qMoss, this._s);
        moss.setMatrixAt(mi, this._m);
        moss.setColorAt(mi, cMoss);
        mi++;
      }
      ti++;
    }
    trunks.count = ti;
    canopy.count = ci;
    moss.count = mi;
    for (const m of [trunks, canopy, moss]) {
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      this.registerMesh(m);
    }
    this.counts.arboles = ti;
  }

  // ---- rocas-menhir musgosas ----

  private buildRocks(rand: () => number): void {
    const rs = this.preset.terrain.rockScatter;
    const density = rs && "density" in rs ? (rs as { density: number }).density : 0.3;
    const menhirCount = MENHIR_COUNT;
    const count = Math.round(ROCK_SCATTER * density) + menhirCount;
    const facets = rs && "lowPolyFacets" in rs ? (rs as { lowPolyFacets: number }).lowPolyFacets : 7;
    const detail = facets >= 12 ? 2 : 1;
    const geo = new THREE.IcosahedronGeometry(0.8, detail);
    geo.computeVertexNormals();
    const mat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const cRock = new THREE.Color(this.preset.palette.ground);
    const cMoss = new THREE.Color(this.preset.palette.primary);
    const col = new THREE.Color();

    // Cono de visión spawn→tótem (origen): sin rocas en ±15° de esa línea hasta 12 u.
    const spawnP = new THREE.Vector3(this.spawnPos.x, 0, this.spawnPos.z);
    const viewDir = new THREE.Vector3(0, 0, 0).sub(spawnP).normalize(); // spawn→origen
    const cosCone = Math.cos(THREE.MathUtils.degToRad(15));
    const toRock = new THREE.Vector3();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 10) {
      const isMenhir = placed < menhirCount;
      // Menhires en el anillo interior (protagonistas), guijarros por toda la isla.
      const p = this.randAnnulus(rand, this.excludeRadius, isMenhir ? 22 : ISLAND_EDGE_BASE - 3);
      const x = p.x;
      const z = p.y;
      if (Math.hypot(x, z) > this.field.edgeRadiusAt(x, z) - 3) continue;
      if (this.field.clearingMask(x, z) > 0.15) continue;
      toRock.set(x, 0, z).sub(spawnP);
      const dist = toRock.length();
      if (dist < 12 && toRock.normalize().dot(viewDir) > cosCone) continue;
      const yaw = rand() * Math.PI * 2;
      const base = 0.7 + rand() * 0.9;
      this._s.set(
        base * (isMenhir ? 0.7 : 1.1),
        base * (isMenhir ? 2.6 + rand() * 1.2 : 0.7 + rand() * 0.4),
        base * (isMenhir ? 0.7 : 1.0),
      );
      const sink = isMenhir ? 0.2 : base * 0.35;
      mesh.setMatrixAt(placed, this.placeMatrix(x, z, yaw, this._s, sink, this._m));
      col.copy(cRock).lerp(cMoss, 0.25 + rand() * 0.35);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
    this.counts.rocas = placed;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.ramp.dispose();
  }
}
