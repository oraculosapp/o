import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";
import { mulberry32 } from "./rng";

/**
 * AmbientLife — VIDA AMBIENTE de la biósfera (equipo Flora).
 *
 * Da la sensación de "mundo vivo" por TODA la isla flotante (no solo el centro):
 *  - MARIPOSAS toon-flat que revolotean con aleteo en el vertex shader (el quad
 *    se dobla por su eje central) y derivan en un vaivén contemplativo.
 *  - MOTAS / SEMILLAS (vilanos) flotantes que suben y bajan suavemente.
 * Repartidas con `insideIsland`, posadas a 0.5–3 u sobre `heightAt` (muestreo al
 * build). Paleta de la casa, `fog:true` para fundirse con la distancia. 2 draw
 * calls (1 InstancedMesh de mariposas + 1 Points de motas). Movimiento reducido
 * (accesibilidad) → velocidad global al 30%.
 *
 * NOTA: módulo del engine — NO importa React.
 */

// ===== Knobs para la ronda de arte =====
const BUTTERFLY_COUNT = 90; // mariposas repartidas por toda la isla
const MOTE_COUNT = 180; // motas/semillas flotantes
const LIFE_Y_MIN = 0.5; // altura mínima sobre el terreno (u)
const LIFE_Y_RANGE = 2.5; // rango extra de altura (u) → 0.5..3.0
const SAMPLE_R_MAX = 56; // radio de muestreo (u); se rechaza fuera de isla
const REDUCED_SPEED = 0.3; // factor de velocidad global en movimiento reducido

// Paleta de la casa: flores lila/oro/turquesa + oro + rosa.
const PALETTE = ["#9B5DE5", "#F4C542", "#37D6C4", "#E3B063", "#F2A6B8"];

export class AmbientLife {
  private group = new THREE.Group();

  private butterflies?: THREE.InstancedMesh;
  private bMat?: THREE.MeshBasicMaterial;
  private motes?: THREE.Points;
  private mMat?: THREE.PointsMaterial;

  /** Reloj de animación (escalado por velocidad → respeta reduced-motion). */
  private animTime = 0;
  private speed = 1;
  /** Uniform compartido por ambos shaders (una escritura/frame). */
  private uAnim = { value: 0 };

  // Estado CPU de las mariposas (deriva + rumbo). ≤90 instancias: coste ínfimo.
  private bAnchor!: Float32Array; // x,y,z del ancla de deriva
  private bR!: Float32Array; // radio de vaivén
  private bW!: Float32Array; // velocidad angular
  private bP!: Float32Array; // fase de deriva
  private bBob!: Float32Array; // amplitud del bob vertical
  private bScale!: Float32Array; // escala por instancia

  // Vectores/matrices de trabajo reutilizables.
  private _pos = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();
  private _m = new THREE.Matrix4();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
  ) {}

  /** Construye geometrías/instancias de la vida ambiente (build-time). */
  build(): void {
    const rand = mulberry32(0x5eed1a);
    this.buildButterflies(rand);
    this.buildMotes(rand);
  }

  /** Añade los objetos a la escena. */
  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Anima la vida ambiente por frame (`dt` = delta seg, `t` = tiempo acumulado). */
  update(dt: number, _t: number): void {
    // Reloj propio escalado por velocidad (reduced-motion frena todo por igual:
    // deriva, aleteo y bob usan `animTime`/`uAnim`).
    this.animTime += dt * this.speed;
    this.uAnim.value = this.animTime;
    this.updateButterflies();
  }

  /** Activa/desactiva el modo de movimiento reducido (accesibilidad). */
  setReducedMotion(b: boolean): void {
    this.speed = b ? REDUCED_SPEED : 1;
  }

  /** Libera geometrías/materiales propios. */
  dispose(): void {
    this.butterflies?.geometry.dispose();
    this.bMat?.dispose();
    this.motes?.geometry.dispose();
    this.mMat?.dispose();
    this.group.clear();
  }

  // ---- muestreo ----

  /** Punto (x,z) dentro de la isla (área-uniforme + rechazo por `insideIsland`). */
  private sampleInside(rand: () => number, out: THREE.Vector2): THREE.Vector2 {
    for (let guard = 0; guard < 24; guard++) {
      const r = Math.sqrt(rand()) * SAMPLE_R_MAX;
      const a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (this.field.insideIsland(x, z)) return out.set(x, z);
    }
    return out.set(0, 0);
  }

  // ---- mariposas ----

  private buildButterflies(rand: () => number): void {
    const n = BUTTERFLY_COUNT;
    this.bAnchor = new Float32Array(n * 3);
    this.bR = new Float32Array(n);
    this.bW = new Float32Array(n);
    this.bP = new Float32Array(n);
    this.bBob = new Float32Array(n);
    this.bScale = new Float32Array(n);

    // Geometría: dos alas (quads) que comparten la espiga central (x=0). El aleteo
    // (vertex shader) rota cada ala alrededor de esa espiga → el quad se "dobla".
    const geo = this.butterflyGeometry();
    const aPhase = new Float32Array(n); // fase de aleteo
    const aFreq = new Float32Array(n); // frecuencia de aleteo

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.96,
      fog: true,
      depthWrite: true,
    });
    this.flapShader(mat);
    this.bMat = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.frustumCulled = false; // dispersas por toda la isla
    const palette = PALETTE.map((c) => new THREE.Color(c));
    const col = new THREE.Color();
    const pt = new THREE.Vector2();

    for (let i = 0; i < n; i++) {
      this.sampleInside(rand, pt);
      const y = this.field.heightAt(pt.x, pt.y) + LIFE_Y_MIN + rand() * LIFE_Y_RANGE;
      this.bAnchor[i * 3] = pt.x;
      this.bAnchor[i * 3 + 1] = y;
      this.bAnchor[i * 3 + 2] = pt.y;
      this.bR[i] = 2 + rand() * 3; // vaivén de 2..5 u
      this.bW[i] = 0.12 + rand() * 0.23; // giro lento (contemplativo)
      this.bP[i] = rand() * Math.PI * 2;
      this.bBob[i] = 0.35 + rand() * 0.45;
      this.bScale[i] = 0.5 + rand() * 0.35;
      aPhase[i] = rand() * Math.PI * 2;
      aFreq[i] = 6 + rand() * 4; // aleteo 6..10 Hz-ish

      // Matriz inicial (se recalcula cada frame en updateButterflies).
      this._s.setScalar(this.bScale[i]);
      this._pos.set(pt.x, y, pt.y);
      this._q.identity();
      this._m.compose(this._pos, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      col.copy(palette[(rand() * palette.length) | 0]);
      mesh.setColorAt(i, col);
    }
    geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(aPhase, 1));
    geo.setAttribute("aFreq", new THREE.InstancedBufferAttribute(aFreq, 1));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.butterflies = mesh;
    this.group.add(mesh);
  }

  /** Dos alas simétricas en el plano XZ (espiga = eje Z en x=0). */
  private butterflyGeometry(): THREE.BufferGeometry {
    const W = 0.42; // media envergadura
    const L = 0.32; // media longitud
    const geo = new THREE.BufferGeometry();
    // Ala izquierda (x<0) + ala derecha (x>0), 2 triángulos cada una.
    // prettier-ignore
    const pos = new Float32Array([
      // izquierda
      -W, 0, -L,  0, 0, -L,  0, 0,  L,
      -W, 0, -L,  0, 0,  L, -W, 0,  L,
      // derecha
       0, 0, -L,  W, 0, -L,  W, 0,  L,
       0, 0, -L,  W, 0,  L,  0, 0,  L,
    ]);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /** Inyecta el aleteo (doblez por la espiga central) en el vertex shader. */
  private flapShader(mat: THREE.MeshBasicMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uAnim = this.uAnim;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           attribute float aPhase; attribute float aFreq; uniform float uAnim;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           // Aleteo: rota cada ala alrededor de la espiga central (x=0) sobre el eje Z.
           float flap = 0.9 * sin(uAnim * aFreq + aPhase);
           float ang = flap * sign(transformed.x);
           float ca = cos(ang), sa = sin(ang);
           float px = transformed.x, py = transformed.y;
           transformed.x = px * ca - py * sa;
           transformed.y = px * sa + py * ca;`,
        );
    };
    mat.needsUpdate = true;
  }

  /** Recoloca cada mariposa (deriva Lissajous + rumbo hacia el movimiento). */
  private updateButterflies(): void {
    const mesh = this.butterflies;
    if (!mesh) return;
    const t = this.animTime;
    const eps = 0.1;
    for (let i = 0; i < mesh.count; i++) {
      const ax = this.bAnchor[i * 3];
      const ay = this.bAnchor[i * 3 + 1];
      const az = this.bAnchor[i * 3 + 2];
      const r = this.bR[i];
      const w = this.bW[i];
      const p = this.bP[i];

      // Posición y una segunda muestra (t+eps) para estimar el rumbo.
      const ang = t * w + p;
      const px = ax + Math.cos(ang) * r + Math.cos(t * 0.3 + p) * 1.2;
      const pz = az + Math.sin(ang * 1.13) * r + Math.sin(t * 0.23 + p) * 1.2;
      const py = ay + Math.sin(t * 0.8 + p) * this.bBob[i];

      const ang2 = (t + eps) * w + p;
      const px2 = ax + Math.cos(ang2) * r + Math.cos((t + eps) * 0.3 + p) * 1.2;
      const pz2 = az + Math.sin(ang2 * 1.13) * r + Math.sin((t + eps) * 0.23 + p) * 1.2;
      const yaw = Math.atan2(px2 - px, pz2 - pz); // orienta el eje +Z hacia el avance

      this._pos.set(px, py, pz);
      this._q.setFromAxisAngle(AmbientLife.UP, yaw);
      this._s.setScalar(this.bScale[i]);
      this._m.compose(this._pos, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- motas / semillas flotantes ----

  private buildMotes(rand: () => number): void {
    const n = MOTE_COUNT;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const aPhase = new Float32Array(n);
    const palette = PALETTE.map((c) => new THREE.Color(c));
    const col = new THREE.Color();
    const pt = new THREE.Vector2();

    for (let i = 0; i < n; i++) {
      this.sampleInside(rand, pt);
      const y = this.field.heightAt(pt.x, pt.y) + LIFE_Y_MIN + rand() * LIFE_Y_RANGE;
      positions[i * 3] = pt.x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = pt.y;
      aPhase[i] = rand() * Math.PI * 2;
      // Motas: favorecen oro/rosa/turquesa (índices 1..4) para un polvo cálido.
      col.copy(palette[1 + ((rand() * (palette.length - 1)) | 0)]);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));

    const mat = new THREE.PointsMaterial({
      size: 0.7,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: true,
    });
    this.moteShader(mat);
    this.mMat = mat;

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.motes = points;
    this.group.add(points);
  }

  /** Inyecta la flotación suave (bob + deriva) de las motas en el vertex shader. */
  private moteShader(mat: THREE.PointsMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uAnim = this.uAnim;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           attribute float aPhase; uniform float uAnim;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           transformed.y += sin(uAnim * 0.6 + aPhase) * 0.6;
           transformed.x += cos(uAnim * 0.4 + aPhase * 1.3) * 0.5;
           transformed.z += sin(uAnim * 0.45 + aPhase * 0.7) * 0.5;`,
        );
    };
    mat.needsUpdate = true;
  }
}
