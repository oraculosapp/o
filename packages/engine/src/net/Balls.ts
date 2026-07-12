import * as THREE from "three";
import { makeToonRamp } from "../util/toon";
import type { BallState, FieldLike } from "./types";

/** Nº de pelotas en el claro. */
const BALL_COUNT = 9;
/** Radio de cada pelota (u). */
const RADIUS = 0.35;
/** Gravedad (u/s²) — igual que el controller para coherencia de sensación. */
const GRAVITY = 22;
/** Restitución del rebote vertical (0 = sin rebote, 1 = elástico). */
const RESTITUTION = 0.42;
/** Umbral de |vy| (u/s) por debajo del cual el rebote se apaga (reposo). */
const BOUNCE_STOP = 0.6;
/** Coef. de fricción de rodadura en el suelo (decaimiento exponencial por s). */
const ROLL_FRICTION = 1.9;
/** Peso del empuje cuesta-abajo por pendiente (0..1). */
const SLOPE_ROLL = 0.5;
/** Velocidad horizontal (u/s) bajo la cual, ya en suelo, la pelota se duerme. */
const SLEEP_SPEED = 0.06;
/**
 * Alcance HORIZONTAL de la patada (u): distancia XZ pies↔centro de pelota.
 * (El contacto 3D contra el PIVOTE del controller — a ~eyeHeight del suelo —
 * dejaba <0.6u de ventana horizontal y en juego real nunca disparaba; S3b.)
 */
const KICK_RANGE = 0.75;
/** Ventana vertical de patada respecto a los pies (u): piernas del avatar. */
const KICK_Y_MIN = -0.6;
const KICK_Y_MAX = 1.4;
/** Factor de transferencia de la velocidad del jugador a la pelota en la patada. */
const KICK_FACTOR = 1.35;
/** Componente vertical mínima que añade una patada (u/s). */
const KICK_LIFT = 1.4;
/** Impulso mínimo de patada aunque el jugador vaya lento (u/s). */
const KICK_MIN = 2.0;
/** Enfriamiento entre emisiones de patada por pelota (s). */
const KICK_COOLDOWN = 0.2;
/** Duración de la reconciliación suave tras applyBallState (s). */
const RECONCILE_TIME = 0.45;

/** Paleta toon variada (8 colores) + 1 dorada al final. */
const BALL_COLORS = [
  0xd76b6b, // coral
  0x6bb0d7, // celeste
  0x8fc46b, // verde lima
  0xd7a86b, // ámbar
  0xb06bd7, // violeta
  0x6bd7b0, // menta
  0xd76bb0, // rosa
  0x6b7bd7, // índigo
  0xe3b063, // ★ dorada (acento de Paqo)
];
/** Índice de la pelota dorada en la paleta (acento de Paqo). */
const GOLD_INDEX = BALL_COLORS.length - 1;
/** Emisivo base de las pelotas normales (suave, que "canten" en su color). */
const EMISSIVE_BASE = 0.22;
/** Emisivo de la pelota dorada (marcado, combina con el anillo-runa y el bloom). */
const EMISSIVE_GOLD = 0.85;

interface Ball {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  grounded: boolean;
  kickCd: number;
  /** Reconciliación de red: objetivo + tiempo restante de blend. */
  recPos?: THREE.Vector3;
  recVel?: THREE.Vector3;
  recTimer: number;
}

/**
 * Las 9 pelotas físicas del claro. Malla instanciada (1 draw call, color por
 * instancia) low-poly toon. Física local ligera anclada a IslandField: gravedad,
 * rodadura sobre heightAt con fricción y rebote suave, patada al contacto con el
 * jugador. Sin red funcionan 100% local; `applyBallState` reconcilia sin teleport.
 */
export class Balls {
  private mesh!: THREE.InstancedMesh;
  private balls: Ball[] = [];
  private kickCbs = new Set<(id: number, s: BallState) => void>();

  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _scale = new THREE.Vector3(1, 1, 1);
  private _n = new THREE.Vector3();
  private _delta = new THREE.Vector3();
  private _tmp = new THREE.Vector3();

  constructor(private field: FieldLike) {}

  /** Construye la malla instanciada y esparce las pelotas por el claro. */
  build(): void {
    const geo = new THREE.IcosahedronGeometry(RADIUS, 1); // low-poly toon (~80 tris)
    // Emisivo/rim por instancia: cada pelota "canta" suave en su propio color;
    // la dorada más marcada (combina con el anillo-runa y el bloom del claro).
    const emis = new Float32Array(BALL_COUNT);
    geo.setAttribute("aEmis", new THREE.InstancedBufferAttribute(emis, 1));
    const mat = this.buildMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, BALL_COUNT);
    this.mesh.name = "net-balls";
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < BALL_COUNT; i++) {
      // Anillo esparcido en el claro (4..9 u del tótem), altura = terreno.
      const a = (i / BALL_COUNT) * Math.PI * 2 + 0.4;
      const r = 4 + (i % 3) * 1.7;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.field.heightAt(x, z) + RADIUS;
      this.balls.push({
        pos: new THREE.Vector3(x, y, z),
        vel: new THREE.Vector3(),
        grounded: true,
        kickCd: 0,
        recTimer: 0,
      });
      const ci = i % BALL_COLORS.length;
      this.mesh.setColorAt(i, new THREE.Color(BALL_COLORS[ci]));
      // Dorada marcada; el resto suave con una variación sutil por posición.
      emis[i] = ci === GOLD_INDEX ? EMISSIVE_GOLD : EMISSIVE_BASE + (i % 3) * 0.05;
    }
    this.syncInstances();
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Material toon instanciado con emisivo + rim inyectados por `onBeforeCompile`.
   * El emisivo tiñe cada pelota en su PROPIO color (leído de `instanceColor`) con
   * intensidad por instancia (`aEmis`), y un rim-light barato (borde que capta el
   * atardecer) la integra a la estética. No toca cielo/fog/paleta del mundo.
   */
  private buildMaterial(): THREE.MeshToonMaterial {
    const mat = new THREE.MeshToonMaterial({ gradientMap: makeToonRamp() });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aEmis;\nvarying float vEmis;\nvarying vec3 vBallColor;",
        )
        .replace(
          "#include <begin_vertex>",
          [
            "#include <begin_vertex>",
            "vEmis = aEmis;",
            "#ifdef USE_INSTANCING_COLOR",
            "  vBallColor = instanceColor;",
            "#else",
            "  vBallColor = vec3(1.0);",
            "#endif",
          ].join("\n"),
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vEmis;\nvarying vec3 vBallColor;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          [
            "#include <emissivemap_fragment>",
            "// Emisivo tenue en el color propio de la pelota (la dorada canta más).",
            "totalEmissiveRadiance += vBallColor * vEmis;",
            "// Rim-light barato en espacio de vista: el borde capta el atardecer.",
            "float _rim = pow(1.0 - abs(normalize(vNormal).z), 3.0);",
            "totalEmissiveRadiance += vBallColor * _rim * (0.28 + vEmis * 0.5);",
          ].join("\n"),
        );
    };
    return mat;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  onKick(cb: (id: number, s: BallState) => void): () => void {
    this.kickCbs.add(cb);
    return () => this.kickCbs.delete(cb);
  }

  /** Reconciliación suave hacia el estado recibido (lerp, no teleport). */
  applyState(id: number, s: BallState): void {
    const b = this.balls[id];
    if (!b) return;
    b.recPos = new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    b.recVel = new THREE.Vector3(s.vel[0], s.vel[1], s.vel[2]);
    b.recTimer = RECONCILE_TIME;
  }

  /** Estado actual de una pelota (para el smoke test / difusión). */
  stateOf(id: number): BallState {
    const b = this.balls[id];
    return {
      pos: [b.pos.x, b.pos.y, b.pos.z],
      vel: [b.vel.x, b.vel.y, b.vel.z],
    };
  }

  /** Energía cinética total (para el smoke test: debe decrecer y llegar a ~0). */
  totalKineticEnergy(): number {
    let e = 0;
    for (const b of this.balls) e += b.vel.lengthSq();
    return 0.5 * e;
  }

  /**
   * Física O(9): gravedad, integración, contacto con el suelo (rebote+fricción+
   * rodadura por pendiente), patada al contacto con el jugador y reconciliación.
   */
  update(dt: number, playerPos: THREE.Vector3, playerVel: THREE.Vector3, playerFeetY?: number): void {
    const feetY = playerFeetY ?? playerPos.y - 0.9;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (b.kickCd > 0) b.kickCd -= dt;

      // --- reconciliación de red: mezcla suave hacia el objetivo recibido ---
      if (b.recTimer > 0 && b.recPos && b.recVel) {
        const alpha = 1 - Math.exp(-6 * dt);
        b.pos.lerp(b.recPos, alpha);
        b.vel.lerp(b.recVel, alpha);
        b.recTimer -= dt;
        if (b.recTimer <= 0) {
          b.recPos = undefined;
          b.recVel = undefined;
        }
      }

      // --- gravedad + integración ---
      b.vel.y -= GRAVITY * dt;
      b.pos.addScaledVector(b.vel, dt);

      // --- contacto con el suelo analítico ---
      const groundY = this.field.heightAt(b.pos.x, b.pos.z) + RADIUS;
      if (b.pos.y <= groundY) {
        b.pos.y = groundY;
        if (b.vel.y < 0) {
          b.vel.y = Math.abs(b.vel.y) > BOUNCE_STOP ? -b.vel.y * RESTITUTION : 0;
        }
        b.grounded = true;

        // Rodadura cuesta-abajo: componente horizontal de la gravedad por pendiente.
        const nrm = this.field.surfaceNormal(b.pos.x, b.pos.z, this._n);
        if (nrm.y > 1e-3) {
          // ∇h = (-nx/ny, -nz/ny); la pelota acelera hacia -∇h (cuesta abajo).
          const gx = -nrm.x / nrm.y;
          const gz = -nrm.z / nrm.y;
          b.vel.x += -gx * GRAVITY * SLOPE_ROLL * dt;
          b.vel.z += -gz * GRAVITY * SLOPE_ROLL * dt;
        }
        // Fricción de rodadura (decae la velocidad horizontal).
        const fr = Math.exp(-ROLL_FRICTION * dt);
        b.vel.x *= fr;
        b.vel.z *= fr;

        // Dormir: en reposo casi total, anclar exactamente al terreno.
        const horiz = Math.hypot(b.vel.x, b.vel.z);
        if (horiz < SLEEP_SPEED && Math.abs(b.vel.y) < BOUNCE_STOP) {
          b.vel.set(0, 0, 0);
          b.pos.y = groundY;
        }
      } else {
        b.grounded = false;
      }

      // --- patada por contacto con el jugador ---
      this.tryKick(i, b, playerPos, playerVel, feetY);
    }
    this.syncInstances();
  }

  private tryKick(
    id: number,
    b: Ball,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    feetY: number,
  ): void {
    // Contacto HORIZONTAL (XZ) pies↔centro de pelota + ventana vertical de
    // piernas. La distancia 3D contra el pivote (a ~eyeHeight) comía el
    // presupuesto vertical y en gameplay real la patada nunca disparaba.
    this._delta.set(b.pos.x - playerPos.x, 0, b.pos.z - playerPos.z);
    const dist = this._delta.length();
    if (dist >= KICK_RANGE) return;
    const rel = b.pos.y - feetY;
    if (rel < KICK_Y_MIN || rel > KICK_Y_MAX) return;

    // Dirección de expulsión horizontal (del jugador a la pelota); si están
    // encimados usa la dirección de avance del jugador.
    if (dist > 1e-4) this._delta.divideScalar(dist);
    else if (this._delta.copy(playerVel).setY(0).lengthSq() > 1e-8) this._delta.normalize();
    else this._delta.set(1, 0, 0);

    // Resuelve penetración en el plano XZ (no hundir la pelota en el suelo).
    b.pos.x += this._delta.x * (KICK_RANGE - dist);
    b.pos.z += this._delta.z * (KICK_RANGE - dist);

    // Impulso horizontal: velocidad del jugador × factor, mínimo garantizado
    // (KICK_MIN aplica también caminando lento).
    const nHoriz = this._tmp.set(this._delta.x, 0, this._delta.z);
    if (nHoriz.lengthSq() < 1e-6) nHoriz.set(playerVel.x, 0, playerVel.z);
    nHoriz.normalize();
    const playerSpeed = Math.hypot(playerVel.x, playerVel.z);
    const impulse = Math.max(playerSpeed * KICK_FACTOR, KICK_MIN);
    b.vel.x += nHoriz.x * impulse;
    b.vel.z += nHoriz.z * impulse;
    b.vel.y += KICK_LIFT;

    // Saltar SOBRE la pelota (jugador bajando y por encima) → empuje extra afuera.
    if (playerVel.y < -0.5 && b.pos.y < playerPos.y) {
      b.vel.x += nHoriz.x * -playerVel.y * 0.6;
      b.vel.z += nHoriz.z * -playerVel.y * 0.6;
      b.vel.y += 0.5;
    }
    b.grounded = false;

    // Emite la patada (con enfriamiento para no spamear mientras hay solape).
    if (b.kickCd <= 0) {
      b.kickCd = KICK_COOLDOWN;
      const s = this.stateOf(id);
      for (const cb of this.kickCbs) cb(id, s);
    }
  }

  private syncInstances(): void {
    for (let i = 0; i < this.balls.length; i++) {
      this._m.compose(this.balls[i].pos, this._q, this._scale);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.kickCbs.clear();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
