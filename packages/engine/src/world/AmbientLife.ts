import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";
import { mulberry32 } from "./rng";

/**
 * AmbientLife — VIDA AMBIENTE de la biósfera (equipo Flora/Arte).
 *
 * Da la sensación de "mundo vivo" por TODA la isla flotante (no solo el centro)
 * con MOTAS / SEMILLAS (vilanos) flotantes que suben y bajan suavemente:
 *  - Blanco cálido (0xf4f1ea, el mismo de las pelotas) para fundirse con el toon
 *    + fog; leve variación de BRILLO por instancia (nunca de matiz).
 *  - Máscara circular suave (canvas 2D, cero assets) para que no se vea el quad.
 *  - Tamaño acotado en el vertex shader (ver MOTE_MAX_PX) para evitar los
 *    "cuadrotes" que salían al acercarse la cámara a un punto (bug clásico de
 *    THREE.Points con sizeAttenuation → gl_PointSize crece sin límite).
 * Repartidas con `insideIsland`, posadas a 0.5–3 u sobre `heightAt` (muestreo al
 * build). `fog:true` para fundirse con la distancia. 1 draw call (1 Points de
 * motas). Movimiento reducido (accesibilidad) → velocidad global al 30%.
 *
 * NOTA: ya NO hay mariposas (retiradas por feedback de arte: se leían como
 * pájaros). Sólo quedan las motas.
 *
 * NOTA: módulo del engine — NO importa React.
 */

// ===== Knobs para la ronda de arte =====
const MOTE_COUNT = 180; // motas/semillas flotantes
const LIFE_Y_MIN = 0.5; // altura mínima sobre el terreno (u)
const LIFE_Y_RANGE = 2.5; // rango extra de altura (u) → 0.5..3.0
const SAMPLE_R_MAX = 56; // radio de muestreo (u); se rechaza fuera de isla
const REDUCED_SPEED = 0.3; // factor de velocidad global en movimiento reducido

// Blanco cálido de la casa (mismo de las pelotas) para las motas.
const MOTE_COLOR = 0xf4f1ea;
// Tope de tamaño de la mota en píxeles: MOTE_MAX_PX · pixelRatio. Acota
// gl_PointSize en el vertex shader para que ningún punto cercano se vea como un
// cuadro enorme. Súbelo si quieres permitir motas más grandes de cerca.
const MOTE_MAX_PX = 22.0;

export class AmbientLife {
  private group = new THREE.Group();

  private motes?: THREE.Points;
  private mMat?: THREE.PointsMaterial;
  private mMap?: THREE.Texture; // máscara circular (canvas 2D)

  /** Reloj de animación (escalado por velocidad → respeta reduced-motion). */
  private animTime = 0;
  private speed = 1;
  /** Uniform compartido por el shader de motas (una escritura/frame). */
  private uAnim = { value: 0 };

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
  ) {}

  /** Construye geometrías/instancias de la vida ambiente (build-time). */
  build(): void {
    const rand = mulberry32(0x5eed1a);
    this.buildMotes(rand);
  }

  /** Añade los objetos a la escena. */
  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Anima la vida ambiente por frame (`dt` = delta seg, `t` = tiempo acumulado). */
  update(dt: number, _t: number): void {
    // Reloj propio escalado por velocidad (reduced-motion frena todo por igual:
    // el bob/deriva de las motas usa `animTime`/`uAnim`).
    this.animTime += dt * this.speed;
    this.uAnim.value = this.animTime;
  }

  /** Activa/desactiva el modo de movimiento reducido (accesibilidad). */
  setReducedMotion(b: boolean): void {
    this.speed = b ? REDUCED_SPEED : 1;
  }

  /** Libera geometrías/materiales propios. */
  dispose(): void {
    this.motes?.geometry.dispose();
    this.mMat?.dispose();
    this.mMap?.dispose();
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

  // ---- motas / semillas flotantes ----

  private buildMotes(rand: () => number): void {
    const n = MOTE_COUNT;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const aPhase = new Float32Array(n);
    const base = new THREE.Color(MOTE_COLOR);
    const pt = new THREE.Vector2();

    for (let i = 0; i < n; i++) {
      this.sampleInside(rand, pt);
      const y = this.field.heightAt(pt.x, pt.y) + LIFE_Y_MIN + rand() * LIFE_Y_RANGE;
      positions[i * 3] = pt.x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = pt.y;
      aPhase[i] = rand() * Math.PI * 2;
      // Blanco cálido con leve variación de BRILLO por instancia (0.8..1.0),
      // nunca de matiz → polvo blanco cálido que respira sin colorearse.
      const b = 0.8 + rand() * 0.2;
      colors[i * 3] = base.r * b;
      colors[i * 3 + 1] = base.g * b;
      colors[i * 3 + 2] = base.b * b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));

    this.mMap = this.circleTexture();
    const mat = new THREE.PointsMaterial({
      size: 0.7,
      sizeAttenuation: true,
      vertexColors: true,
      map: this.mMap, // máscara circular suave → no se ve el quad
      alphaTest: 0.02,
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

  /**
   * Máscara circular suave dibujada en un canvas 2D (cero assets). Radial:
   * blanco opaco al centro → transparente al borde. Con `map` + `alphaTest` la
   * mota deja de verse como cuadrado.
   */
  private circleTexture(): THREE.Texture {
    const S = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.85)");
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Inyecta la flotación suave (bob + deriva) de las motas en el vertex shader
   * y ACOTA gl_PointSize a MOTE_MAX_PX · pixelRatio.
   *
   * El clamp se inserta justo antes de `#include <fog_vertex>` (que en el
   * points_vert de three.js va después de calcular gl_PointSize con
   * sizeAttenuation), de modo que topa el valor final: sin importar cuán cerca
   * pase la cámara, ningún punto excede el tope y desaparecen los "cuadrotes".
   * El tope se hornea como literal GLSL (pixelRatio resuelto al compilar).
   */
  private moteShader(mat: THREE.PointsMaterial): void {
    const dpr =
      typeof window !== "undefined" && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1;
    const maxPx = (MOTE_MAX_PX * dpr).toFixed(1);
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
        )
        .replace(
          "#include <fog_vertex>",
          `gl_PointSize = min(gl_PointSize, ${maxPx});
           #include <fog_vertex>`,
        );
    };
    mat.needsUpdate = true;
  }
}
