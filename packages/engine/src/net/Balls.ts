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

/** Blanco cálido único para TODAS las pelotas (combina con el toon del mundo). */
const BALL_COLOR = 0xf4f1ea;
/** Emisivo base muy tenue: un glow blanco sutil que no las apague ni las haga farolas. */
const EMISSIVE_BASE = 0.06;

/** Alcance HORIZONTAL (u, plano XZ) para agarrar la pelota más cercana con E. */
const GRAB_RANGE = 1.5;
/** Distancia frontal (u) a la que flota la pelota agarrada, delante del avatar. */
const HOLD_FORWARD = 0.62;
/** Altura (u) sobre los pies a la que flota la pelota agarrada (a la altura de manos). */
const HOLD_HEIGHT = 1.15;
/** Rapidez (u/s) del lanzamiento en la dirección de mirada. */
const THROW_SPEED = 9.5;
/** Componente vertical (u/s) del lanzamiento: da el arco. */
const THROW_ARC = 4.6;
/** Fracción de la velocidad del jugador que hereda la pelota al lanzarla. */
const THROW_INHERIT = 0.5;

/**
 * Radio (u, plano XZ desde el origen) de la ZONA CENTRAL de juego. El claro llega
 * a ~15 u y el anfiteatro a r=20; 18 deja jugar en el claro sin que las pelotas se
 * pierdan monte arriba. La regla de zona está SIEMPRE activa (con o sin partida):
 * una pelota cuyo centro salga de r>ZONE_RADIUS (o caiga bajo el claro) respawnea
 * instantáneamente a su "slot casa" determinista.
 */
const ZONE_RADIUS = 18;
/** Margen de caída (u) bajo el nivel del claro que también dispara el respawn. */
const ZONE_FALL_MARGIN = 8;

interface Ball {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  grounded: boolean;
  kickCd: number;
  /**
   * true si esta pelota fue LANZADA por el jugador local (throwBall) y sigue
   * "viva" (aún no durmió, ni fue agarrada, ni respawneó). El mini-juego usa esta
   * bandera como autoridad del lanzador: sólo este cliente detecta el golpe a Paqo
   * de SUS pelotas; los remotos se enteran por el evento de red.
   */
  thrownLive: boolean;
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
  private throwCbs = new Set<(id: number) => void>();
  private respawnCbs = new Set<(id: number, s: BallState, reason: "out" | "hit") => void>();

  // --- agarrar / lanzar ---
  /** Índice de la pelota agarrada, o -1 si no llevas ninguna (solo una a la vez). */
  private heldId = -1;
  /** Índice de la pelota agarrable resaltada por el sprite E este frame (-1 = ninguna). */
  private hintId = -1;
  /** Sprite billboard con el glifo "E" que aparece sobre la pelota agarrable. */
  private eSprite?: THREE.Sprite;
  private eTex?: THREE.Texture;
  private time = 0;

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
    // Emisivo/rim por instancia: todas iguales, un glow blanco muy tenue que las
    // integra al toon del claro sin apagarlas ni convertirlas en farolas.
    const emis = new Float32Array(BALL_COUNT);
    geo.setAttribute("aEmis", new THREE.InstancedBufferAttribute(emis, 1));
    const mat = this.buildMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, BALL_COUNT);
    this.mesh.name = "net-balls";
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < BALL_COUNT; i++) {
      // Anillo esparcido en el claro (slot casa determinista, 4..9 u del tótem).
      const home = this.homeSlot(i, new THREE.Vector3());
      this.balls.push({
        pos: home,
        vel: new THREE.Vector3(),
        grounded: true,
        kickCd: 0,
        thrownLive: false,
        recTimer: 0,
      });
      this.mesh.setColorAt(i, new THREE.Color(BALL_COLOR));
      // Todas iguales: blanco cálido con un emisivo muy tenue.
      emis[i] = EMISSIVE_BASE;
    }
    this.syncInstances();
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.buildEHint();
  }

  /**
   * Sprite billboard con el glifo "E" (textura generada en canvas 2D, estilo de
   * marca: tecla redondeada clara con la letra E). Un THREE.Sprite mira SIEMPRE a
   * cámara sin coste; la flotación la aplica `update`. Oculto hasta que hay una
   * pelota agarrable cerca y no llevas ninguna. Cero DOM.
   */
  /**
   * Posición "slot casa" determinista de la pelota `i`: el mismo anillo de build
   * (a=(i/9)·2π+0.4, r=4+(i%3)·1.7), anclado a la altura del terreno. Es adonde
   * respawnea al salir de la zona o al golpear a Paqo — igual en todos los clientes.
   */
  homeSlot(i: number, out: THREE.Vector3): THREE.Vector3 {
    const a = (i / BALL_COUNT) * Math.PI * 2 + 0.4;
    const r = 4 + (i % 3) * 1.7;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    return out.set(x, this.field.heightAt(x, z) + RADIUS, z);
  }

  private buildEHint(): void {
    // Sin DOM (SSR/tests) no hay sprite E: el resto de la física funciona igual.
    if (typeof document === "undefined") return;
    this.eTex = this.makeKeyTexture("E");
    const mat = new THREE.SpriteMaterial({
      map: this.eTex,
      transparent: true,
      depthTest: false, // siempre legible sobre la pelota
      depthWrite: false,
      fog: false,
    });
    this.eSprite = new THREE.Sprite(mat);
    this.eSprite.scale.set(0.6, 0.6, 0.6);
    this.eSprite.renderOrder = 6;
    this.eSprite.visible = false;
    this.eSprite.name = "ball-grab-hint-E";
  }

  /** Textura de "tecla" redondeada clara con una letra centrada (canvas 2D). */
  private makeKeyTexture(glyph: string): THREE.CanvasTexture {
    const s = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = s;
    const ctx = canvas.getContext("2d")!;
    const pad = 14;
    const r = 26;
    const x = pad;
    const y = pad;
    const w = s - pad * 2;
    const h = s - pad * 2;
    // Cuerpo de la tecla: redondeada clara con borde ámbar de la marca.
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "rgba(255,252,245,0.97)");
    g.addColorStop(1, "rgba(232,220,198,0.95)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(227,176,99,0.95)"; // ámbar de marca
    ctx.stroke();
    // Sombra interior sutil bajo el borde superior (relieve de tecla).
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 3;
    ctx.stroke();
    // Glifo.
    ctx.fillStyle = "#2a2118";
    ctx.font = `700 ${Math.round(h * 0.62)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, s / 2, s / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Material toon instanciado con emisivo + rim inyectados por `onBeforeCompile`.
   * El emisivo aporta un glow blanco muy tenue (leído de `instanceColor` = blanco
   * cálido, con intensidad por instancia `aEmis`), y un rim-light barato (borde que
   * capta el atardecer) la integra a la estética. No toca cielo/fog/paleta del mundo.
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
            "// Emisivo blanco muy tenue (glow sutil, uniforme en todas).",
            "totalEmissiveRadiance += vBallColor * vEmis;",
            "// Rim-light barato en espacio de vista: el borde capta el atardecer, muy sutil.",
            "float _rim = pow(1.0 - abs(normalize(vNormal).z), 3.0);",
            "totalEmissiveRadiance += vBallColor * _rim * (0.10 + vEmis * 0.25);",
          ].join("\n"),
        );
    };
    return mat;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
    if (this.eSprite) scene.add(this.eSprite);
  }

  onKick(cb: (id: number, s: BallState) => void): () => void {
    this.kickCbs.add(cb);
    return () => this.kickCbs.delete(cb);
  }

  /** Suscribe LANZAMIENTOS locales (throwBall). Distinto de la patada al caminar. */
  onThrow(cb: (id: number) => void): () => void {
    this.throwCbs.add(cb);
    return () => this.throwCbs.delete(cb);
  }

  /**
   * Suscribe RESPAWNS de pelota (salida de zona o golpe a Paqo). `reason` distingue
   * el motivo; `s` es el nuevo estado (slot casa) para FX/sonido. La difusión de red
   * reutiliza `onKick` (respawnToHome emite también por ahí), así que los remotos
   * reconcilian sin un canal nuevo.
   */
  onRespawn(cb: (id: number, s: BallState, reason: "out" | "hit") => void): () => void {
    this.respawnCbs.add(cb);
    return () => this.respawnCbs.delete(cb);
  }

  /** Nº de pelotas. */
  get count(): number {
    return this.balls.length;
  }

  /** ¿La pelota `id` fue lanzada por el jugador local y sigue viva? */
  isThrownLive(id: number): boolean {
    return this.balls[id]?.thrownLive === true;
  }

  /** Copia la posición actual de la pelota `id` en `out`. */
  positionOf(id: number, out: THREE.Vector3): THREE.Vector3 {
    const b = this.balls[id];
    return b ? out.copy(b.pos) : out.set(0, 0, 0);
  }

  /**
   * Teleporta la pelota `id` a su slot casa (respawn INSTANTÁNEO, sin lerp). Si la
   * llevabas agarrada, se te esfuma de las manos (force-drop). Limpia velocidad,
   * reconciliación y la bandera `thrownLive`. Emite `onRespawn` (FX/sonido) y
   * reutiliza `onKick` para que la red difunda el nuevo estado a los remotos.
   */
  respawnToHome(id: number, reason: "out" | "hit"): void {
    const b = this.balls[id];
    if (!b) return;
    if (id === this.heldId) {
      this.heldId = -1;
      if (this.eSprite) this.eSprite.visible = false;
    }
    this.homeSlot(id, b.pos);
    b.vel.set(0, 0, 0);
    b.grounded = true;
    b.thrownLive = false;
    b.kickCd = 0;
    b.recPos = undefined;
    b.recVel = undefined;
    b.recTimer = 0;
    const s = this.stateOf(id);
    for (const cb of this.respawnCbs) cb(id, s, reason);
    // Difusión de red: reutiliza el canal de patadas para que los remotos snap a casa.
    for (const cb of this.kickCbs) cb(id, s);
  }

  // ---- agarrar / lanzar ----

  /**
   * Índice de la pelota agarrable más cercana en el plano XZ dentro de GRAB_RANGE,
   * o -1 si ninguna (o si ya llevas una). No considera la pelota agarrada.
   */
  nearestGrabbable(px: number, pz: number): number {
    if (this.heldId >= 0) return -1;
    let best = -1;
    let bestD = GRAB_RANGE;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      const d = Math.hypot(b.pos.x - px, b.pos.z - pz);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** ¿Llevas una pelota agarrada ahora mismo? */
  isHolding(): boolean {
    return this.heldId >= 0;
  }

  /** Índice de la pelota agarrada, o -1. */
  heldBall(): number {
    return this.heldId;
  }

  /** ¿Hay una pelota agarrable al alcance (y no llevas ninguna)? */
  canGrab(px: number, pz: number): boolean {
    return this.nearestGrabbable(px, pz) >= 0;
  }

  /**
   * Agarra la pelota `id`: se "pega" al jugador (flota frente a las manos), se
   * desactiva su física libre. Solo una a la vez. Devuelve true si se agarró.
   */
  grab(id: number): boolean {
    if (this.heldId >= 0) return false;
    const b = this.balls[id];
    if (!b) return false;
    this.heldId = id;
    b.vel.set(0, 0, 0);
    b.grounded = false;
    b.thrownLive = false; // agarrarla cancela el estado de "lanzada viva"
    b.recPos = undefined;
    b.recVel = undefined;
    b.recTimer = 0;
    if (this.eSprite) this.eSprite.visible = false;
    return true;
  }

  /**
   * Lanza la pelota agarrada en la dirección `dir` (mirada del avatar) con impulso
   * + arco, heredando algo de la velocidad del jugador. Reactiva su física libre.
   * Emite la patada (para que la red la propague). Devuelve true si lanzó.
   */
  throwBall(dir: THREE.Vector3, playerVel: THREE.Vector3): boolean {
    if (this.heldId < 0) return false;
    const id = this.heldId;
    const b = this.balls[id];
    this.heldId = -1;

    this._tmp.set(dir.x, 0, dir.z);
    if (this._tmp.lengthSq() < 1e-6) this._tmp.set(0, 0, -1);
    this._tmp.normalize();
    b.vel.set(
      this._tmp.x * THROW_SPEED + playerVel.x * THROW_INHERIT,
      THROW_ARC + Math.max(0, dir.y) * THROW_SPEED,
      this._tmp.z * THROW_SPEED + playerVel.z * THROW_INHERIT,
    );
    b.grounded = false;
    b.kickCd = KICK_COOLDOWN;
    // Marca de LANZAMIENTO local: sólo este cliente sabe que él la lanzó. El
    // mini-juego la usa como autoridad para detectar el golpe a Paqo.
    b.thrownLive = true;

    const s = this.stateOf(id);
    for (const cb of this.kickCbs) cb(id, s);
    for (const cb of this.throwCbs) cb(id);
    return true;
  }

  /** Reconciliación suave hacia el estado recibido (lerp, no teleport). */
  applyState(id: number, s: BallState): void {
    const b = this.balls[id];
    if (!b) return;
    if (id === this.heldId) return; // la pelota agarrada la manda el portador local
    // Reconciliación entrante FUERA de zona: en vez de lerp hacia el monte, snap al
    // slot casa. Así todos los clientes convergen sin pelearse por una pelota perdida.
    if (Math.hypot(s.pos[0], s.pos[2]) > ZONE_RADIUS) {
      this.homeSlot(id, b.pos);
      b.vel.set(0, 0, 0);
      b.grounded = true;
      b.thrownLive = false;
      b.recPos = undefined;
      b.recVel = undefined;
      b.recTimer = 0;
      return;
    }
    b.recPos = new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]);
    b.recVel = new THREE.Vector3(s.vel[0], s.vel[1], s.vel[2]);
    b.recTimer = RECONCILE_TIME;
  }

  /**
   * Rebote horizontal simple contra un cilindro vertical (centro cx,cz, radio r):
   * refleja la componente horizontal de la velocidad con restitución y empuja la
   * pelota justo fuera del cilindro. Lo usa el mini-juego para el "cariño" de Paqo
   * cuando NO hay partida (Paqo reacciona un poco sin puntuar ni respawnear).
   */
  deflect(id: number, cx: number, cz: number, radius: number, restitution: number): void {
    const b = this.balls[id];
    if (!b) return;
    let nx = b.pos.x - cx;
    let nz = b.pos.z - cz;
    let d = Math.hypot(nx, nz);
    if (d < 1e-4) {
      // Encimada al eje: usa la velocidad inversa como normal, o +X por defecto.
      nx = -b.vel.x;
      nz = -b.vel.z;
      d = Math.hypot(nx, nz);
      if (d < 1e-4) {
        nx = 1;
        nz = 0;
        d = 1;
      }
    }
    nx /= d;
    nz /= d;
    const vn = b.vel.x * nx + b.vel.z * nz;
    if (vn < 0) {
      // Se movía HACIA el tótem: refleja esa componente con restitución.
      const j = -(1 + restitution) * vn;
      b.vel.x += j * nx;
      b.vel.z += j * nz;
    }
    // Sácala justo al borde del cilindro (no la dejes penetrando).
    b.pos.x = cx + nx * radius;
    b.pos.z = cz + nz * radius;
    b.vel.y += 0.4; // saltito juguetón
    b.grounded = false;
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
  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    playerFeetY?: number,
    holdTarget?: THREE.Vector3,
  ): void {
    this.time += dt;
    const feetY = playerFeetY ?? playerPos.y - 0.9;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (b.kickCd > 0) b.kickCd -= dt;

      // --- pelota agarrada: sigue el punto de agarre (frente/manos), sin física ---
      if (i === this.heldId) {
        // Si te llevas la pelota FUERA de la zona central se te esfuma de las manos
        // (force-drop) y respawnea a casa. La zona está siempre activa.
        if (holdTarget && Math.hypot(holdTarget.x, holdTarget.z) > ZONE_RADIUS) {
          this.respawnToHome(i, "out");
          continue;
        }
        if (holdTarget) b.pos.copy(holdTarget);
        b.vel.set(0, 0, 0);
        b.grounded = false;
        continue;
      }

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
          b.thrownLive = false; // durmió: ya no cuenta como lanzamiento vivo
        }
      } else {
        b.grounded = false;
      }

      // --- ZONA CENTRAL (siempre activa): fuera de r>18 o caída al vacío → casa ---
      if (
        Math.hypot(b.pos.x, b.pos.z) > ZONE_RADIUS ||
        b.pos.y < this.field.clearLevel - ZONE_FALL_MARGIN
      ) {
        this.respawnToHome(i, "out");
        continue;
      }

      // --- patada por contacto con el jugador ---
      this.tryKick(i, b, playerPos, playerVel, feetY);
    }
    this.syncInstances();
    this.updateEHint(playerPos);
  }

  /**
   * Coloca/oculta el sprite E: visible sobre la pelota agarrable más cercana
   * cuando no llevas ninguna; se esconde al agarrar o alejarte. Leve flotación.
   */
  private updateEHint(playerPos: THREE.Vector3): void {
    const sprite = this.eSprite;
    if (!sprite) return;
    const id = this.nearestGrabbable(playerPos.x, playerPos.z);
    this.hintId = id;
    if (id < 0) {
      sprite.visible = false;
      return;
    }
    const b = this.balls[id];
    const bob = Math.sin(this.time * 3.2) * 0.07;
    sprite.position.set(b.pos.x, b.pos.y + RADIUS + 0.55 + bob, b.pos.z);
    sprite.visible = true;
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
    this.throwCbs.clear();
    this.respawnCbs.clear();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    if (this.eSprite) {
      this.eSprite.removeFromParent();
      (this.eSprite.material as THREE.SpriteMaterial).dispose();
    }
    this.eTex?.dispose();
  }
}
