import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PlanetField } from "../planet/PlanetField";
import type { BiospherePreset } from "../planet/types";
import { makeToonRamp } from "../util/toon";
import { mulberry32, randomDirInCap } from "./rng";

type WindUniform = { value: number };

/**
 * Vegetación instanciada del valle de Paqo, fiel a la ficha de arte:
 * pasto alto denso (cards cruzadas con vaivén de viento en shader), árboles
 * "guardianes" retorcidos low-poly agrupados en los bordes (con musgo
 * colgante), helechos y flores salpicadas en el claro, y rocas-menhir musgosas.
 *
 * Todo se posa con la MISMA PlanetField.heightAt (única fuente de verdad de la
 * forma del terreno) y excluye un radio íntimo alrededor del tótem. Pocas draw
 * calls: 1 InstancedMesh por pieza (pasto, tronco, copa, musgo, helecho, flor,
 * roca) — 7 draw calls para miles de instancias.
 */
export class Vegetation {
  readonly group = new THREE.Group();
  private windUniforms: WindUniform[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private ramp = makeToonRamp();

  // Zona jugable/visible del money-shot: casquete alrededor del claro (+Y).
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly excludeRadius = 5; // u libres alrededor del tótem
  private readonly R: number;
  /** Pendiente máxima (rad) donde aún se planta pasto alto (~40°). */
  private static readonly MAX_GRASS_SLOPE = THREE.MathUtils.degToRad(40);

  // Trabajo reutilizable.
  private _dir = new THREE.Vector3();
  private _pos = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _up = new THREE.Vector3();
  private _s = new THREE.Vector3();
  private _m = new THREE.Matrix4();
  private _yaw = new THREE.Quaternion();

  constructor(
    private field: PlanetField,
    private preset: BiospherePreset,
    /** Dirección de spawn: define el cono de visión spawn→tótem libre de rocas. */
    private spawnDir = new THREE.Vector3(0, 1, 0.18).normalize(),
  ) {
    this.R = field.radius;
  }

  build(): void {
    const rand = mulberry32(0x9a3c1);
    this.buildGrass(rand);
    // Anclas de agrupación: puntos en el anillo de bordes (donde viven árboles y
    // rocas). Helechos y matas se aglomeran ahí — nada de dispersión uniforme.
    const clumps = this.clumpAnchors(rand, 16);
    this.buildShrubs(rand, clumps);
    this.buildFerns(rand, clumps);
    this.buildFlowers(rand);
    this.buildTrees(rand);
    this.buildRocks(rand);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Avanza el reloj de viento (un solo uniform compartido por todos los shaders). */
  update(_dt: number, t: number): void {
    for (const u of this.windUniforms) u.value = t;
  }

  // ---- helpers de colocación ----

  private excludeAngle(): number {
    return this.excludeRadius / this.R;
  }

  // Scratch para la normal del terreno (solo build-time).
  private _nrm = new THREE.Vector3();
  private _tU = new THREE.Vector3();
  private _tV = new THREE.Vector3();
  private _pA = new THREE.Vector3();
  private _pB = new THREE.Vector3();
  private _eU = new THREE.Vector3();
  private _eV = new THREE.Vector3();

  /**
   * Normal REAL del terreno en `dir` por diferencias centrales: 4 muestras de
   * superficie (±ε tangente) → cross de las dos secantes. Orientada hacia
   * afuera (dot con el radial > 0). Solo se usa al construir, no por frame.
   */
  private terrainNormal(dir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const eps = 0.3 / this.R; // paso angular ~0.3 u de arco
    this.tangentBasis(dir, this._tU, this._tV);
    this.field.surfacePoint(this._pA.copy(dir).addScaledVector(this._tU, eps).normalize(), this._pA);
    this.field.surfacePoint(this._pB.copy(dir).addScaledVector(this._tU, -eps).normalize(), this._pB);
    this._eU.subVectors(this._pA, this._pB);
    this.field.surfacePoint(this._pA.copy(dir).addScaledVector(this._tV, eps).normalize(), this._pA);
    this.field.surfacePoint(this._pB.copy(dir).addScaledVector(this._tV, -eps).normalize(), this._pB);
    this._eV.subVectors(this._pA, this._pB);
    out.crossVectors(this._eU, this._eV).normalize();
    if (out.dot(dir) < 0) out.negate();
    return out;
  }

  /** Pendiente (rad) del terreno en `dir`: ángulo entre la normal real y el radial. */
  private slopeAt(dir: THREE.Vector3): number {
    this.terrainNormal(dir, this._nrm);
    return Math.acos(THREE.MathUtils.clamp(this._nrm.dot(dir), -1, 1));
  }

  /**
   * Excedente máximo (u) con que la huella de la base (±halfW local en X/Z)
   * queda POR ENCIMA del terreno tras aplicar `m`. Las crestas del ruido
   * ridged pueden dejar una esquina en voladizo aunque la planta esté
   * alineada — este probe lo detecta para hundirla ese extra. Solo build-time.
   */
  private footprintOverhang(m: THREE.Matrix4, halfW: number): number {
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      this._pA.set(k === 0 ? halfW : k === 1 ? -halfW : 0, 0, k === 2 ? halfW : k === 3 ? -halfW : 0);
      this._pA.applyMatrix4(m);
      this._pB.copy(this._pA).normalize();
      const above = this._pA.length() - (this.R + this.field.heightAt(this._pB));
      if (above > worst) worst = above;
    }
    return worst;
  }

  /**
   * Matriz de instancia: posa `dir` en el suelo con yaw y escala dados.
   * `align` mezcla el up entre radial puro (0) y la normal real del terreno
   * (1): con ~0.6-0.7 las plantas acompañan la cuesta y su base muerde la
   * ladera en vez de quedar en voladizo cuesta abajo. `sink` hunde la base a
   * lo largo del up resultante. Árboles y rocas siguen radiales (se ven bien).
   */
  private placeMatrix(
    dir: THREE.Vector3,
    yaw: number,
    scale: THREE.Vector3,
    sink = 0,
    out = new THREE.Matrix4(),
    align = 0,
  ): THREE.Matrix4 {
    this.field.surfacePoint(dir, this._pos);
    if (align > 0) {
      this.terrainNormal(dir, this._nrm);
      this._up.copy(dir).multiplyScalar(1 - align).addScaledVector(this._nrm, align).normalize();
    } else {
      this._up.copy(dir); // radial puro (terreno suave); barato y estable
    }
    this._pos.addScaledVector(this._up, -sink);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._up);
    this._yaw.setFromAxisAngle(this._up, yaw);
    this._q.premultiply(this._yaw);
    out.compose(this._pos, this._q, scale);
    return out;
  }

  /**
   * Anclas de agrupación en el anillo de bordes del claro (donde se agolpan
   * árboles guardianes y rocas-menhir): 14..22 u de arco, fuera del claro. Los
   * helechos y matas cuelgan de estas anclas → masa vegetal intencional al pie
   * de la arboleda, no confeti disperso por todo el casquete.
   */
  private clumpAnchors(rand: () => number, n: number): THREE.Vector3[] {
    const anchors: THREE.Vector3[] = [];
    const excl = this.excludeAngle();
    const minA = Math.max(13 / this.R, excl);
    let guard = 0;
    while (anchors.length < n && guard++ < n * 12) {
      randomDirInCap(rand, 22 / this.R, this.axis, minA, this._dir);
      if (this.field.clearingMask(this._dir) > 0.25) continue; // bordes, no el centro
      anchors.push(this._dir.clone());
    }
    return anchors;
  }

  /** Base ortonormal tangente a una dirección (para esparcir matas/clusters). */
  private tangentBasis(dir: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
    const t = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u.crossVectors(t, dir).normalize();
    v.crossVectors(dir, u);
  }

  /**
   * Una fronda de helecho: listón arqueado que sube desde el centro y se dobla
   * hacia afuera-abajo (arco de curvatura constante). Sección transversal en ∧
   * (tienda) con cresta central alzada → sus normales miran arriba/afuera y se
   * ilumina como el suelo (nada de caras negras). Taper hacia la punta.
   */
  private fernFrond(seed: number): THREE.BufferGeometry {
    const S = 2; // segmentos → hasta 8 tris
    const Ls = 0.82 + seed * 0.28; // largo de arco
    const maxBend = 2.05 + seed * 0.5; // >π/2: la punta sobrepasa la horizontal y cae
    const r = Ls / maxBend;
    const w0 = 0.09; // media anchura en la base
    const secC: THREE.Vector3[] = [];
    const secL: THREE.Vector3[] = [];
    const secR: THREE.Vector3[] = [];
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      const ang = t * maxBend;
      const x = r * (1 - Math.cos(ang));
      const y = r * Math.sin(ang);
      const w = w0 * Math.pow(1 - t, 0.6);
      const dip = w * 0.55; // los bordes bajan respecto a la cresta → tienda ∧
      secC.push(new THREE.Vector3(x, y, 0));
      secL.push(new THREE.Vector3(x, y - dip, w));
      secR.push(new THREE.Vector3(x, y - dip, -w));
    }
    const pos: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < S; i++) {
      // Ala izquierda (cresta↔borde izq) y ala derecha (cresta↔borde der).
      push(secC[i], secL[i], secL[i + 1]);
      push(secC[i], secL[i + 1], secC[i + 1]);
      push(secC[i], secC[i + 1], secR[i + 1]);
      push(secC[i], secR[i + 1], secR[i]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return geo;
  }

  /** Planta de helecho: 6 frondas radiales arqueadas, malla 3D chunky. */
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
    merged.computeVertexNormals(); // facetado (per-vértice sobre non-indexed)
    return merged;
  }

  /** Tallo de flor: prisma triangular finito facetado, base en y=0. */
  private flowerStem(h: number): THREE.BufferGeometry {
    const geo = new THREE.CylinderGeometry(0.012, 0.02, h, 3, 1).toNonIndexed();
    geo.translate(0, h / 2, 0);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Corola facetada como gema achatada (pirámide hexagonal baja): 6 tris, punto
   * de color CON volumen. Anclada sobre el tallo (base del anillo en y=`atY`).
   */
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

  /** Blob facetado low-poly (icosfera deformada y achatada) para matas/arbustos. */
  private shrubBlob(): THREE.BufferGeometry {
    // IcosahedronGeometry ya es non-indexed (una tripleta por cara) → deformar
    // por posición no abre grietas y computeVertexNormals da facetas planas.
    const geo = new THREE.IcosahedronGeometry(0.6, 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    // Deformación determinista: achatada en Y + protuberancias irregulares.
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(pos, i);
      const bump = 0.82 + 0.32 * Math.sin(n.x * 5.1 + n.y * 3.3) * Math.cos(n.z * 4.7 + 1.2);
      pos.setXYZ(i, n.x * bump, n.y * bump * 0.62, n.z * bump);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals(); // facetas planas chunky
    return geo;
  }

  /**
   * Cortina de musgo colgante (Old Man's Beard): cono alargado irregular con la
   * base ancha arriba (rama) afinando a la punta abajo. La instancia se orienta
   * con +Y hacia abajo → cuelga hacia el suelo; el viento mece la punta.
   */
  private mossCone(): THREE.BufferGeometry {
    const geo = new THREE.ConeGeometry(0.22, 1.0, 5, 2, true).toNonIndexed();
    geo.translate(0, 0.5, 0); // base en y=0, punta en y=+1 (la instancia lo cuelga)
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const k = 1 - v.y; // más ancho arriba (rama), afinado abajo
      const j = 0.14 * Math.sin(v.y * 7.3 + i * 1.1);
      pos.setXYZ(i, v.x * (0.7 + 0.5 * k) + j, v.y, v.z * (0.7 + 0.5 * k) - j);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Apunta todas las normales al +Y local (radial tras instanciar): las cards
   * se iluminan como el suelo — nada de quads negros de espaldas a la luz.
   */
  private upNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
    nor.needsUpdate = true;
    return geo;
  }

  /**
   * Hoja de pasto afilada: base angosta con taper triangular hacia la punta
   * (3 tris por cara), cruzada en X. Perfil fino — nada de placas anchas.
   */
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

  /** Inyecta vaivén de viento: dobla la punta según altura local y fase por instancia. */
  private windShader(mat: THREE.MeshToonMaterial, height: number, amp: number): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uWindH = { value: height };
      shader.uniforms.uWindAmp = { value: amp };
      this.windUniforms.push(shader.uniforms.uTime as WindUniform);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform float uTime; uniform float uWindH; uniform float uWindAmp;`,
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
           transformed.x += sway * bend * uWindAmp;
           transformed.z += cos(uTime * 1.05 + ph) * 0.10 * bend * uWindAmp;`,
        );
    };
    mat.needsUpdate = true;
  }

  private registerMesh(mesh: THREE.InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false; // instancias esparcidas en todo el casquete
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  // ---- pasto ----

  private buildGrass(rand: () => number): void {
    const g = this.preset.vegetation?.grass ?? {};
    // Hojas más angostas → más instancias para densidad visual equivalente.
    const count = Math.round(8500 * (g.density ?? 0.85));
    const height = g.height ?? 1.4;
    const geo = this.upNormals(this.bladeCross(0.16, height));
    const mat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide,
      alphaTest: 0.0,
    });
    this.windShader(mat, height, g.windSway ?? 0.6);

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const cAccent = new THREE.Color(this.preset.palette.accent); // pradera ácida
    const cSage = new THREE.Color(this.preset.palette.secondary); // salvia
    const cDeep = new THREE.Color(this.preset.palette.primary); // musgo
    const col = new THREE.Color();
    const excl = this.excludeAngle();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8) {
      randomDirInCap(rand, 24 / this.R, this.axis, excl, this._dir);
      const yaw = rand() * Math.PI * 2;
      // Ficha: "densidad media, concentrada en bordes" + el avatar SIEMPRE
      // visible de rodillas para arriba en el claro → dentro de la máscara del
      // claro (>0.4) el pasto es CORTO (~0.3-0.4 u) y ralo (~30% de densidad);
      // el pasto alto y denso vive fuera (bordes/anfiteatro).
      const mask = this.field.clearingMask(this._dir);
      const inClearing = mask > 0.4;
      if (inClearing && rand() > 0.3) continue; // adelgaza la pradera
      // Umbral de pendiente: en cuestas muy fuertes (>40°) NADA de pasto —
      // ahí es donde más flota y menos aporta; la ladera queda limpia (roca).
      if (this.slopeAt(this._dir) > Vegetation.MAX_GRASS_SLOPE) continue;
      const sc = 0.7 + rand() * 0.6;
      const ySc = inClearing ? 0.22 + rand() * 0.07 : 0.85 + rand() * 0.4;
      this._s.set(sc, ySc, sc);
      // Base hundida proporcional al tamaño + alineada ~70% a la pendiente:
      // la base siempre muerde el terreno cuesta arriba/abajo.
      const sink = 0.06 + 0.05 * sc;
      this.placeMatrix(this._dir, yaw, this._s, sink, this._m, 0.7);
      // Garantía anti-flote: si aun así alguna esquina de la huella queda en
      // voladizo (crestas afiladas del ruido ridged), se DESCARTA el punto y
      // el bucle reintenta en otro lado — toda base colocada muerde terreno.
      if (this.footprintOverhang(this._m, 0.08) > 0.001) continue;
      mesh.setMatrixAt(placed, this._m);
      // Variación de color: base salvia→ácida, algunas más profundas; la
      // pradera corta del claro tira más a ácida (pradera de la ficha).
      col.copy(cSage).lerp(cAccent, inClearing ? 0.45 + rand() * 0.4 : rand() * 0.7);
      if (!inClearing && rand() < 0.25) col.lerp(cDeep, 0.4);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
  }

  // ---- helechos / matas ----

  private buildFerns(rand: () => number, clumps: THREE.Vector3[]): void {
    const s = this.preset.vegetation?.shrubs;
    // ~40% menos elementos de plano medio que el sistema de cards anterior.
    const count = Math.round(200 * (s?.density ?? 0.4));
    const geo = this.fernPlant(); // malla 3D (6 frondas arqueadas)
    const mat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide, // fronda vista por cualquier lado: nunca hueco/negro
    });
    // Vaivén suave: la punta de la fronda (~0.4 u) ondea, base quieta.
    this.windShader(mat, 0.4, 0.28);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    // Verde helecho legible: salvia→ácida (no la banda oscura del primary).
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const cAccent = new THREE.Color(this.preset.palette.accent);
    const col = new THREE.Color();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();

    let placed = 0;
    for (let a = 0; a < clumps.length && placed < count; a++) {
      const anchor = clumps[a];
      this.tangentBasis(anchor, u, v);
      // Mata de 2-4 helechos al pie de la arboleda/roca (radio ~1.8 u).
      const per = 2 + ((rand() * 3) | 0);
      for (let k = 0; k < per && placed < count; k++) {
        const r = (rand() * 1.8) / this.R;
        const ang = rand() * Math.PI * 2;
        this._dir
          .copy(anchor)
          .addScaledVector(u, Math.cos(ang) * r)
          .addScaledVector(v, Math.sin(ang) * r)
          .normalize();
        if (this.field.clearingMask(this._dir) > 0.3) continue; // claro limpio
        const yaw = rand() * Math.PI * 2;
        const sc = 0.85 + rand() * 0.7;
        this._s.set(sc, sc * (0.85 + rand() * 0.35), sc);
        // Hundido proporcional + alineado a la pendiente: el rosetón muerde la ladera.
        const sink = 0.05 + 0.05 * sc;
        mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, sink, this._m, 0.65));
        col.copy(cSage).lerp(cAccent, 0.2 + rand() * 0.45);
        mesh.setColorAt(placed, col);
        placed++;
      }
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
  }

  // ---- matas / arbustos (blobs facetados low-poly) ----

  private buildShrubs(rand: () => number, clumps: THREE.Vector3[]): void {
    const s = this.preset.vegetation?.shrubs;
    const count = Math.round(130 * (s?.density ?? 0.4)); // masa vegetal intermedia
    const geo = this.shrubBlob();
    const mat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    this.windShader(mat, 0.5, 0.12); // masa casi rígida, apenas respira
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    // Verde vegetal apagado: musgo profundo→salvia (masa, no acento brillante).
    const cDeep = new THREE.Color(this.preset.palette.primary);
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const col = new THREE.Color();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    // 3 tamaños discretos → matas chunky intencionales, no ruido continuo.
    const sizes = [0.75, 1.05, 1.5];

    let placed = 0;
    for (let a = 0; a < clumps.length && placed < count; a++) {
      const anchor = clumps[a];
      this.tangentBasis(anchor, u, v);
      const per = 1 + ((rand() * 2) | 0); // 1-2 matas por ancla
      for (let k = 0; k < per && placed < count; k++) {
        const r = (rand() * 2.2) / this.R;
        const ang = rand() * Math.PI * 2;
        this._dir
          .copy(anchor)
          .addScaledVector(u, Math.cos(ang) * r)
          .addScaledVector(v, Math.sin(ang) * r)
          .normalize();
        if (this.field.clearingMask(this._dir) > 0.25) continue;
        const base = sizes[(rand() * sizes.length) | 0];
        const yaw = rand() * Math.PI * 2;
        this._s.set(base * (0.9 + rand() * 0.2), base * (0.85 + rand() * 0.3), base * (0.9 + rand() * 0.2));
        // Nestle: hunde ~mitad del blob y alinea a la pendiente — asienta en la ladera.
        mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, base * 0.26, this._m, 0.6));
        col.copy(cDeep).lerp(cSage, 0.35 + rand() * 0.4);
        mesh.setColorAt(placed, col);
        placed++;
      }
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
  }

  // ---- flores (blancas / naranjas salpicadas) ----

  private buildFlowers(rand: () => number): void {
    const f = this.preset.vegetation?.flowers;
    // Menos flores que el confeti anterior (~40% menos), en los BORDES del claro.
    const count = Math.round(850 * (f?.density ?? 0.15));
    const stemH = 0.22;
    // Dos mallas que comparten matriz por flor: tallo verde + corola de color.
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
    const excl = this.excludeAngle();
    const col = new THREE.Color();
    const center = new THREE.Vector3();
    const tanU = new THREE.Vector3();
    const tanV = new THREE.Vector3();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8) {
      // Centro de mata en el ANILLO del borde del claro (arco ~9..16 u): la
      // pradera central queda limpia, las flores orlan el claro.
      randomDirInCap(rand, 16 / this.R, this.axis, Math.max(9 / this.R, excl), center);
      const mask = this.field.clearingMask(center);
      if (mask < 0.08 || mask > 0.9) continue; // solo el borde, ni centro ni fuera
      this.tangentBasis(center, tanU, tanV);
      const clusterColor = palette[(rand() * palette.length) | 0];
      const mixed = rand() < 0.3;
      const clusterSize = 3 + ((rand() * 3) | 0); // matas de 3-5
      for (let k = 0; k < clusterSize && placed < count; k++) {
        const r = (rand() * 0.5) / this.R;
        const a = rand() * Math.PI * 2;
        this._dir
          .copy(center)
          .addScaledVector(tanU, Math.cos(a) * r)
          .addScaledVector(tanV, Math.sin(a) * r)
          .normalize();
        const yaw = rand() * Math.PI * 2;
        const sc = 0.75 + rand() * 0.5;
        this._s.set(sc, sc, sc);
        // Hundido proporcional + alineado: el tallo nace DEL suelo, no del aire.
        this.placeMatrix(this._dir, yaw, this._s, 0.025 + 0.025 * sc, this._m, 0.65);
        stems.setMatrixAt(placed, this._m);
        corollas.setMatrixAt(placed, this._m);
        // 2 tonos por mata: base / aclarada hacia blanco → mancha con volumen.
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
  }

  // ---- árboles guardianes retorcidos + musgo colgante ----

  private buildTrees(rand: () => number): void {
    const tp = this.preset.vegetation?.trees;
    const treeCount = Math.round(70 * (tp?.density ?? 0.35));
    const excl = this.excludeAngle();

    // Geometrías base (faceted low-poly). MeshToonMaterial no soporta
    // flatShading → se facetan las normales en la propia geometría
    // (non-indexed + computeVertexNormals = una normal por cara).
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
    this.windShader(mossMat, 1.0, 0.45); // la punta (y=1) del cono se mece

    const blobsPerTree = 3;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const canopy = new THREE.InstancedMesh(blobGeo, canopyMat, treeCount * blobsPerTree);
    // Cortina cónica 3D (Old Man's Beard) que cuelga de la copa.
    const mossGeo = this.mossCone();
    const moss = new THREE.InstancedMesh(mossGeo, mossMat, treeCount * 2);

    const cBark = new THREE.Color(this.preset.palette.ground).multiplyScalar(0.75);
    const cLeafA = new THREE.Color(this.preset.palette.primary);
    const cLeafB = new THREE.Color(this.preset.palette.secondary);
    const cMoss = new THREE.Color(this.preset.palette.secondary).lerp(
      new THREE.Color(0xbfcbb6),
      0.5,
    ); // desaturado (Old Man's Beard)
    const col = new THREE.Color();

    let ti = 0;
    let ci = 0;
    let mi = 0;
    let guard = 0;
    while (ti < treeCount && guard++ < treeCount * 8) {
      // Guardianes agrupados en bordes/cornisas: anillo del anfiteatro (~16..24 u).
      const clusterAtEdges = tp?.clusterAtEdges !== false;
      const minA = clusterAtEdges ? 15 / this.R : excl;
      const maxA = 24 / this.R;
      randomDirInCap(rand, maxA, this.axis, Math.max(minA, excl), this._dir);
      const yaw = rand() * Math.PI * 2;
      const scale = 1.4 + rand() * 1.3; // guardianes de porte variable
      const lean = 0.12 + rand() * 0.14; // "retorcido": tronco inclinado

      // Tronco con leve inclinación (twist gnarled).
      this.field.surfacePoint(this._dir, this._pos);
      this._up.copy(this._dir);
      this._pos.addScaledVector(this._up, -0.2);
      this._q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._up);
      this._yaw.setFromAxisAngle(this._up, yaw);
      this._q.premultiply(this._yaw);
      // Inclinación adicional alrededor de un eje tangente.
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

      // Copas: 3 blobs facetados agrupados en la punta.
      const topLocal = new THREE.Vector3(0, 2.6, 0);
      for (let b = 0; b < blobsPerTree; b++) {
        const off = new THREE.Vector3(
          (rand() - 0.5) * 1.3,
          2.4 + rand() * 1.1,
          (rand() - 0.5) * 1.3,
        );
        const bScale = (0.9 + rand() * 0.7) * scale * 0.85;
        // Transforma el offset local por la orientación del árbol.
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
        void topLocal;
      }

      // Musgo colgante en ~60% de los árboles (cornisas): cuelga de la copa.
      if (tp?.mossHang !== false && rand() < 0.6 && mi < moss.count) {
        // Se ancla arriba en el tronco/copa, con leve desplazamiento lateral.
        const lateral = new THREE.Vector3((rand() - 0.5) * 1.4, 0, (rand() - 0.5) * 1.4)
          .applyQuaternion(this._q)
          .multiplyScalar(scale * 0.6);
        const attach = this._pos
          .clone()
          .addScaledVector(this._up, scale * 1.7)
          .add(lateral);
        // Orientación con +Y local hacia ABAJO → la cortina cuelga al suelo.
        const down = this._up.clone().negate();
        const qMoss = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), down);
        qMoss.multiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2),
        );
        const len = scale * (0.8 + rand() * 0.5); // punta por encima del suelo
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
  }

  // ---- rocas-menhir musgosas ----

  private buildRocks(rand: () => number): void {
    const rs = this.preset.terrain.rockScatter;
    const density = rs && "density" in rs ? (rs as { density: number }).density : 0.3;
    const menhirCount = 4;
    const count = Math.round(40 * density) + menhirCount;
    const facets = rs && "lowPolyFacets" in rs ? (rs as { lowPolyFacets: number }).lowPolyFacets : 7;
    const detail = facets >= 12 ? 2 : 1;
    const geo = new THREE.IcosahedronGeometry(0.8, detail);
    geo.computeVertexNormals(); // facetas planas (menhir low-poly)
    const mat = new THREE.MeshToonMaterial({ gradientMap: this.ramp });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const cRock = new THREE.Color(this.preset.palette.ground);
    const cMoss = new THREE.Color(this.preset.palette.primary);
    const col = new THREE.Color();
    const excl = this.excludeAngle();

    // Cono de visión spawn→tótem: nada de rocas en ±15° de esa línea hasta
    // 12 u — el money shot del encuadre inicial queda SIN obstrucciones.
    const spawnP = this.field.surfacePoint(this.spawnDir.clone().normalize());
    const totemP = this.field.surfacePoint(this.axis);
    const viewDir = totemP.clone().sub(spawnP).normalize();
    const cosCone = Math.cos(THREE.MathUtils.degToRad(15));
    const toRock = new THREE.Vector3();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 10) {
      const isMenhir = placed < menhirCount;
      randomDirInCap(rand, 22 / this.R, this.axis, excl, this._dir);
      // Las rocas-menhir van en laderas y bordes (ficha): fuera del claro
      // completo, incluida su transición.
      if (this.field.clearingMask(this._dir) > 0.15) continue;
      // Fuera del cono de visión spawn→tótem.
      this.field.surfacePoint(this._dir, toRock).sub(spawnP);
      const dist = toRock.length();
      if (dist < 12 && toRock.normalize().dot(viewDir) > cosCone) continue;
      const yaw = rand() * Math.PI * 2;
      const base = 0.7 + rand() * 0.9;
      // Menhir: alto y estrecho; roca: achatada.
      this._s.set(
        base * (isMenhir ? 0.7 : 1.1),
        base * (isMenhir ? 2.6 + rand() * 1.2 : 0.7 + rand() * 0.4),
        base * (isMenhir ? 0.7 : 1.0),
      );
      const sink = isMenhir ? 0.2 : base * 0.35;
      mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, sink, this._m));
      // Mossy: mezcla roca + musgo (rs.mossy).
      col.copy(cRock).lerp(cMoss, 0.25 + rand() * 0.35);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.ramp.dispose();
  }
}
