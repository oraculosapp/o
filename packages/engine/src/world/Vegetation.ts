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
    this.buildFerns(rand);
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

  /** Matriz de instancia: posa `dir` en el suelo, up=normal, yaw y escala dados. */
  private placeMatrix(
    dir: THREE.Vector3,
    yaw: number,
    scale: THREE.Vector3,
    sink = 0,
    out = new THREE.Matrix4(),
  ): THREE.Matrix4 {
    this.field.surfacePoint(dir, this._pos);
    this._up.copy(dir); // normal ~ radial (terreno suave); barato y estable
    this._pos.addScaledVector(this._up, -sink);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._up);
    this._yaw.setFromAxisAngle(this._up, yaw);
    this._q.premultiply(this._yaw);
    out.compose(this._pos, this._q, scale);
    return out;
  }

  /** Cara plana cruzada (2 quads) de ancho w y alto h, base en y=0. */
  private crossedCard(w: number, h: number): THREE.BufferGeometry {
    const p1 = new THREE.PlaneGeometry(w, h);
    p1.translate(0, h / 2, 0);
    const p2 = p1.clone();
    p2.rotateY(Math.PI / 2);
    const merged = mergeGeometries([p1, p2], false)!;
    p1.dispose();
    p2.dispose();
    return merged;
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
      const sc = 0.7 + rand() * 0.6;
      const ySc = inClearing ? 0.22 + rand() * 0.07 : 0.85 + rand() * 0.4;
      this._s.set(sc, ySc, sc);
      mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, 0.06, this._m));
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

  private buildFerns(rand: () => number): void {
    const s = this.preset.vegetation?.shrubs;
    const count = Math.round(320 * (s?.density ?? 0.4));
    // Normales hacia arriba: se iluminan como el suelo (nada de placas negras).
    const geo = this.upNormals(this.crossedCard(1.1, 0.8));
    const mat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide,
    });
    this.windShader(mat, 0.8, 0.35);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    // Verde helecho legible: salvia→ácida (no la banda oscura del primary).
    const cSage = new THREE.Color(this.preset.palette.secondary);
    const cAccent = new THREE.Color(this.preset.palette.accent);
    const col = new THREE.Color();
    const excl = this.excludeAngle();

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 6) {
      randomDirInCap(rand, 20 / this.R, this.axis, excl, this._dir);
      const yaw = rand() * Math.PI * 2;
      const sc = 0.8 + rand() * 0.7;
      this._s.set(sc, sc * (0.8 + rand() * 0.4), sc);
      mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, 0.1, this._m));
      col.copy(cSage).lerp(cAccent, 0.2 + rand() * 0.4);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
  }

  // ---- flores (blancas / naranjas salpicadas) ----

  private buildFlowers(rand: () => number): void {
    const f = this.preset.vegetation?.flowers;
    const count = Math.round(1400 * (f?.density ?? 0.15));
    // Flores pequeñas (nada de confeti): card chica y matas de 3-5.
    const geo = this.upNormals(this.crossedCard(0.22, 0.34));
    const mat = new THREE.MeshToonMaterial({
      gradientMap: this.ramp,
      side: THREE.DoubleSide,
    });
    // Vaivén muy leve para que no queden rígidas.
    this.windShader(mat, 0.26, 0.2);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const palette = (f?.colors?.length ? f.colors : ["#E8ECEA", "#E67E22"]).map(
      (c) => new THREE.Color(c),
    );
    const excl = this.excludeAngle();
    const col = new THREE.Color();
    const center = new THREE.Vector3();
    const tanU = new THREE.Vector3();
    const tanV = new THREE.Vector3();
    const tmp = new THREE.Vector3(1, 0, 0);

    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 6) {
      // Centro de mata en el claro florido (hasta ~16 u).
      randomDirInCap(rand, 16 / this.R, this.axis, excl, center);
      // Base tangente para esparcir la mata (~0.6 u de radio).
      tanU.crossVectors(tmp, center).normalize();
      tanV.crossVectors(center, tanU);
      // Color de la mata: blanca o naranja; algunas matas mezcladas.
      const clusterColor = palette[(rand() * palette.length) | 0];
      const mixed = rand() < 0.3;
      const clusterSize = 3 + ((rand() * 3) | 0); // 3-5 flores
      for (let k = 0; k < clusterSize && placed < count; k++) {
        const r = (rand() * 0.6) / this.R;
        const a = rand() * Math.PI * 2;
        this._dir
          .copy(center)
          .addScaledVector(tanU, Math.cos(a) * r)
          .addScaledVector(tanV, Math.sin(a) * r)
          .normalize();
        const yaw = rand() * Math.PI * 2;
        const sc = 0.6 + rand() * 0.5;
        this._s.set(sc, sc, sc);
        mesh.setMatrixAt(placed, this.placeMatrix(this._dir, yaw, this._s, 0.03, this._m));
        // 2 tonos por mata: alternar flor base / flor aclarada hacia blanco
        // (la mata se lee como mancha con volumen, no puntito suelto).
        col.copy(mixed ? palette[(rand() * palette.length) | 0] : clusterColor);
        if (k % 2 === 1) col.lerp(new THREE.Color(0xffffff), 0.35);
        mesh.setColorAt(placed, col);
        placed++;
      }
    }
    mesh.count = placed;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.registerMesh(mesh);
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
    this.windShader(mossMat, 1.4, 0.4);

    const blobsPerTree = 3;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const canopy = new THREE.InstancedMesh(blobGeo, canopyMat, treeCount * blobsPerTree);
    // Normales hacia arriba: el musgo se lee verde pálido, no placa negra.
    const mossGeo = this.upNormals(this.crossedCard(0.5, 1.4));
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

      // Musgo colgante en ~60% de los árboles (cornisas).
      if (tp?.mossHang !== false && rand() < 0.6 && mi < moss.count) {
        const mOff = new THREE.Vector3((rand() - 0.5) * 1.2, 1.6 + rand() * 0.8, (rand() - 0.5) * 1.2)
          .applyQuaternion(this._q)
          .multiplyScalar(scale * 0.6);
        this._s.set(scale * 0.9, scale * (1.1 + rand() * 0.6), scale * 0.9);
        this._m.compose(this._pos.clone().add(mOff), this._q, this._s);
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
