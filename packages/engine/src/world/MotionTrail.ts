import * as THREE from "three";

/**
 * MotionTrail — ESTELA DE PARTÍCULAS de los pies (equipo Vuelo/Mandos).
 *
 * Un ÚNICO `THREE.Points` global con un pool finito de slots (POOL): 1 draw call
 * total para el jugador local Y todos los remotos. Las motas son BLANCAS CÁLIDAS
 * (0xf4f1ea, el mismo blanco de la casa que usan AmbientLife/pelotas), pequeñas,
 * con clamp de tamaño en píxeles (como AmbientLife → nada de "cuadrotes" al
 * acercarse). Cada mota vive ~LIFE s con fade + una leve deriva (sube y se abre).
 *
 * Se emite desde los PIES cuando la velocidad horizontal supera un umbral (y
 * SIEMPRE en vuelo). El emisor decide la cadencia (throttle) y llama `emit()`;
 * el pool es un anillo: al agotarse reescribe el slot más viejo (nunca falla).
 *
 * Todo el fade/deriva/atenuación vive en un ShaderMaterial minúsculo (una sola
 * escritura de uniform `uTime` por frame; las motas se "hornean" al emitir). Sin
 * texturas: el disco suave se calcula en el fragment desde `gl_PointCoord` (cero
 * dependencia de `document`, seguro en SSR/tests).
 *
 * NOTA: módulo del engine — NO importa React.
 */

/** Tamaño del pool de motas (slots del anillo). ~120 = varios emisores holgados. */
const POOL = 120;
/** Vida de cada mota (s). */
const LIFE = 0.8;
/** Blanco cálido de la casa. */
const TRAIL_COLOR = 0xf4f1ea;

export class MotionTrail {
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private points: THREE.Points;

  // Atributos por-mota: posición de NACIMIENTO, instante de nacimiento y deriva.
  private position = new Float32Array(POOL * 3);
  private aBirth = new Float32Array(POOL);
  private aVel = new Float32Array(POOL * 3);
  private posAttr: THREE.BufferAttribute;
  private birthAttr: THREE.BufferAttribute;
  private velAttr: THREE.BufferAttribute;

  /** Cursor del anillo (siguiente slot a reescribir). */
  private cursor = 0;
  /** Reloj propio (avanza en update; escala por reduced-motion). */
  private time = 0;
  private speed = 1;
  private uTime = { value: 0 };
  private dirty = false;

  constructor() {
    // Todas las motas nacen "muertas" (birth muy atrás → life<0 → tamaño 0).
    this.aBirth.fill(-1000);
    this.posAttr = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.birthAttr = new THREE.BufferAttribute(this.aBirth, 1).setUsage(THREE.DynamicDrawUsage);
    this.velAttr = new THREE.BufferAttribute(this.aVel, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.posAttr);
    this.geo.setAttribute("aBirth", this.birthAttr);
    this.geo.setAttribute("aVel", this.velAttr);
    this.geo.setDrawRange(0, POOL);

    const dpr =
      typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    // Tamaño en px (atenuado por distancia): pequeño y con tope, estilo AmbientLife.
    const sizePx = (150 * dpr).toFixed(1);
    const maxPx = (16 * dpr).toFixed(1);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: this.uTime,
        uLife: { value: LIFE },
        uColor: { value: new THREE.Color(TRAIL_COLOR) },
      },
      vertexShader: /* glsl */ `
        attribute float aBirth;
        attribute vec3 aVel;
        uniform float uTime;
        uniform float uLife;
        varying float vLife;
        void main() {
          float age = uTime - aBirth;
          vLife = clamp(1.0 - age / uLife, 0.0, 1.0);
          // Deriva: la mota se abre/sube con la edad (aVel horneado al emitir).
          vec3 p = position + aVel * age;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Atenuación por distancia + encogimiento al morir; clamp de px.
          float sz = ${sizePx} / max(-mv.z, 0.001) * (0.35 + 0.65 * vLife);
          gl_PointSize = min(sz, ${maxPx});
          if (vLife <= 0.0) gl_PointSize = 0.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vLife;
        void main() {
          // Disco suave calculado en el fragment (sin textura).
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          float mask = smoothstep(0.5, 0.08, d);
          float a = mask * vLife * 0.8;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false; // pool disperso: nunca lo recortes por bbox
    this.points.renderOrder = 2;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.points);
  }

  /** Movimiento reducido (accesibilidad): frena el reloj de deriva/fade. */
  setReducedMotion(b: boolean): void {
    this.speed = b ? 0.3 : 1;
  }

  /**
   * Emite UNA mota en (x,y,z) — típicamente los pies del emisor. El emisor decide
   * la cadencia (p.ej. cada ~0.04 s mientras se mueve). Reescribe el slot más
   * viejo del anillo con una leve deriva aleatoria (mayormente hacia arriba).
   */
  emit(x: number, y: number, z: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % POOL;
    this.position[i * 3] = x;
    this.position[i * 3 + 1] = y;
    this.position[i * 3 + 2] = z;
    this.aBirth[i] = this.time;
    // Deriva: abre en XZ (±0.5 u/s) y sube suave (0.2..0.8 u/s).
    this.aVel[i * 3] = (Math.random() - 0.5) * 1.0;
    this.aVel[i * 3 + 1] = 0.2 + Math.random() * 0.6;
    this.aVel[i * 3 + 2] = (Math.random() - 0.5) * 1.0;
    this.dirty = true;
  }

  /** Avanza el reloj (una escritura de uniform); sube los atributos si hubo emisión. */
  update(dt: number): void {
    this.time += dt * this.speed;
    this.uTime.value = this.time;
    if (this.dirty) {
      this.posAttr.needsUpdate = true;
      this.birthAttr.needsUpdate = true;
      this.velAttr.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
  }
}
