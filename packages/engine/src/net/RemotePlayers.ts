import * as THREE from "three";
import { TestDummy } from "../avatar/TestDummy";
import { loadAvatarRigShared, isAllowedArchetypeUrl } from "../avatar/AvatarGLTFCache";
import { buildArchetype, isArchetypeId as isProceduralArchetypeId, avatarGlbUrl } from "../avatar/archetypes";
import type { AvatarDriveState, IAvatarRig } from "../avatar/types";
import { makeSoftCircleTexture } from "../util/toon";
import type { MotionEmitter, NetAnim, RemoteState } from "./types";

const UP = new THREE.Vector3(0, 1, 0);
/** Velocidad horizontal (u/s) del remoto por encima de la cual deja estela. */
const TRAIL_SPEED = 2;
/** Cadencia de emisión de estela por remoto (s). */
const TRAIL_EMIT_DT = 0.045;

/** Cap del pool de remotos (presupuesto de draw calls / memoria). */
const MAX_REMOTES = 32;
/** Retardo del buffer de interpolación (s): rendermos ~120 ms en el pasado. */
const INTERP_DELAY = 0.12;
/** Ventana de muestras a conservar por remoto (s). */
const SAMPLE_WINDOW = 1.0;
/** Duración del fundido de aparición/desaparición (s). */
const FADE_TIME = 0.4;
/** Distancia (u) a la que la etiqueta empieza a desvanecerse y a la que llega a 0. */
const LABEL_NEAR = 15;
const LABEL_FAR = 20;

/** Una muestra temporal recibida por la red (para interpolar). */
interface Sample {
  t: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/** Mapea una anim de red a un estado de conducción que el AnimationDriver traduce. */
function driveStateFor(anim: string): AvatarDriveState {
  const a = anim as NetAnim;
  // maxSpeed 7 (runSpeed del controller). El driver elige por ratio speed/maxSpeed:
  //   <0.12 idle · <0.62 walk · >=0.62 run · jumping → jump.
  switch (a) {
    case "run":
      return { speed: 7, maxSpeed: 7, grounded: true, jumping: false };
    case "walk":
      return { speed: 3, maxSpeed: 7, grounded: true, jumping: false };
    case "jump":
      return { speed: 3, maxSpeed: 7, grounded: false, jumping: true };
    // Vuelo: pose de aire (no hay clip "fly"; el air-pose se lee mejor que idle).
    case "fly":
      return { speed: 3, maxSpeed: 7, grounded: false, jumping: true };
    case "idle":
    default:
      // Cualquier string desconocido cae aquí → idle (tolerancia de red).
      return { speed: 0, maxSpeed: 7, grounded: true, jumping: false };
  }
}

/**
 * Un avatar remoto: TestDummy con tinte, holder que sigue la posición/yaw
 * interpolados, etiqueta de nombre (sprite canvas 2D) y fundido de entrada/salida.
 * Sin colisión con el jugador (estilo Messenger: se atraviesan).
 */
class RemoteAvatar {
  readonly holder = new THREE.Group();
  private rig: IAvatarRig = new TestDummy();
  private samples: Sample[] = [];
  private materials: THREE.Material[] = [];
  private label?: THREE.Sprite;
  private labelTex?: THREE.Texture;
  private curName?: string;
  private curTint?: string;
  private curArchetype?: string;
  private loadingArchetype = false;

  /** Fundido 0..1 (aparición) y estado de retirada. */
  private fade = 0;
  private removing = false;
  private dead = false;

  private puff?: THREE.Points;
  private puffLife = 0;

  // Estela de partículas (equipo Vuelo): emite desde los pies al moverse/volar.
  private curAnim = "idle";
  private prevPos = new THREE.Vector3();
  private hasPrev = false;
  private trailAcc = 0;

  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _q = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    private motionTrail?: MotionEmitter,
  ) {
    // El rig se ancla por su base (pies). El estado de red trae el CENTRO del
    // avatar (igual que getLocalState), así que bajamos el rig media altura.
    this.rig.root.position.set(0, -this.rig.height / 2, 0);
    this.holder.add(this.rig.root);
    scene.add(this.holder);

    this.collectFadeMaterials();
    this.spawnPuff(scene);
  }

  /** Recolecta los materiales del rig actual y los prepara para el fundido. */
  private collectFadeMaterials(): void {
    this.materials = [];
    this.rig.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        mat.transparent = true;
        mat.opacity = this.fade;
        this.materials.push(mat);
      }
    });
  }

  /**
   * Adopta el arquetipo del remoto. El valor que llega por presencia/broadcast es
   * un ID de arquetipo (string, p.ej. "vampiro"):
   *   · si es uno de los 9 PROCEDURALES → se construye el rig con `buildArchetype`
   *     (100% código, instantáneo, SIN fetch) y se hot-swap conservando
   *     posición/interpolación (viven en `holder`, no en `rig.root`);
   *   · si no, se conserva el camino de GLB same-origin como fallback (uso futuro):
   *     carga perezosa desde la caché compartida y sustitución al terminar. Si
   *     falla (404 o error), se queda con el maniquí — nunca rompe.
   */
  setArchetype(id?: string): void {
    if (!id || id === this.curArchetype || this.loadingArchetype) return;

    // Avatar MODELADO nuevo ("<arquetipo>-<f|m|n>"): carga perezosa del GLB
    // generado desde /assets/avatars/gen/ (caché compartida, hot-swap al llegar).
    // Si falla, cae al chibi procedural del mismo arquetipo (nunca rompe).
    const genUrl = avatarGlbUrl(id);
    if (genUrl) {
      this.curArchetype = id;
      this.loadingArchetype = true;
      loadAvatarRigShared(genUrl)
        .then((rig) => {
          this.loadingArchetype = false;
          if (this.dead) {
            rig.dispose();
            return;
          }
          this.swapRig(rig);
        })
        .catch(() => {
          this.loadingArchetype = false;
          // Fallback: chibi procedural del arquetipo base (id "<arquetipo>").
          const base = id.slice(0, id.lastIndexOf("-"));
          if (!this.dead && isProceduralArchetypeId(base)) {
            try {
              this.swapRig(buildArchetype(base));
            } catch {
              /* se queda con el maniquí */
            }
          }
        });
      return;
    }

    // Camino procedural (los 9 ids "pelados" viejos): construcción local
    // instantánea, sin red — compat con clientes/localStorage antiguos.
    if (isProceduralArchetypeId(id)) {
      this.curArchetype = id;
      try {
        this.swapRig(buildArchetype(id));
      } catch {
        // Nunca rompe: si algo fallara al construir, se queda con el rig actual.
      }
      return;
    }

    // Legado: GLB por URL. Seguridad (M-5): sólo arquetipos same-origin bajo
    // /assets/avatars/. Un broadcast malicioso con URL externa se ignora.
    if (!isAllowedArchetypeUrl(id)) return;
    this.curArchetype = id;
    this.loadingArchetype = true;
    loadAvatarRigShared(id)
      .then((rig) => {
        this.loadingArchetype = false;
        if (this.dead) {
          rig.dispose();
          return;
        }
        this.swapRig(rig);
      })
      .catch(() => {
        // Arquetipo aún inexistente: seguimos con el maniquí.
        this.loadingArchetype = false;
      });
  }

  /** Sustituye el rig del holder conservando tinte, fundido y etiqueta. */
  private swapRig(rig: IAvatarRig): void {
    const tint = this.curTint;
    this.holder.remove(this.rig.root);
    this.rig.dispose();
    this.rig = rig;
    rig.root.position.set(0, -rig.height / 2, 0);
    this.holder.add(rig.root);
    this.collectFadeMaterials();
    if (tint) rig.setTint({ primary: new THREE.Color(tint) });
    if (this.label) this.label.position.set(0, rig.height / 2 + 0.55, 0);
  }

  /** Aplica un estado recibido: encola muestra, actualiza tinte/nombre. */
  push(s: RemoteState, now: number): void {
    if (this.removing) this.removing = false; // reaparición antes de morir
    this._q.setFromAxisAngle(UP, s.yaw);
    this.samples.push({
      t: now,
      pos: new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]),
      quat: this._q.clone(),
    });
    // Poda muestras viejas.
    const cutoff = now - SAMPLE_WINDOW;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();

    if (s.tint && s.tint !== this.curTint) {
      this.curTint = s.tint;
      this.rig.setTint({ primary: new THREE.Color(s.tint) });
    }
    if (s.name !== this.curName) {
      this.curName = s.name;
      this.setLabel(s.name);
    }
  }

  /** Inicia la retirada (fundido de salida; se libera al terminar). */
  beginRemove(): void {
    this.removing = true;
  }

  isDead(): boolean {
    return this.dead;
  }

  /**
   * Avanza el remoto: interpola posición (lerp) y yaw (slerp) a `renderTime`,
   * conduce la animación y gestiona los fundidos/etiqueta.
   */
  update(dt: number, renderTime: number, cameraPos: THREE.Vector3): void {
    if (this.dead) return;

    // --- interpolación ---
    const n = this.samples.length;
    if (n === 1) {
      this.holder.position.copy(this.samples[0].pos);
      this.holder.quaternion.copy(this.samples[0].quat);
    } else if (n >= 2) {
      // Busca el par que rodea renderTime (o extrapola-clamp a los extremos).
      let i = n - 1;
      while (i > 0 && this.samples[i - 1].t > renderTime) i--;
      const a = this.samples[Math.max(0, i - 1)];
      const b = this.samples[i];
      const span = b.t - a.t;
      const alpha = span > 1e-5 ? THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1) : 1;
      this.holder.position.copy(this._a.copy(a.pos).lerp(this._b.copy(b.pos), alpha));
      this.holder.quaternion.slerpQuaternions(a.quat, b.quat, alpha);
    }

    // --- estela de partículas desde los pies (equipo Vuelo) ---
    // Emite cuando el remoto se mueve rápido (>TRAIL_SPEED) o SIEMPRE en vuelo.
    if (this.motionTrail && this.fade > 0.5 && dt > 1e-5) {
      let speed = 0;
      if (this.hasPrev) speed = this._a.copy(this.holder.position).sub(this.prevPos).length() / dt;
      this.prevPos.copy(this.holder.position);
      this.hasPrev = true;
      if (speed > TRAIL_SPEED || this.curAnim === "fly") {
        this.trailAcc += dt;
        // El holder trae el CENTRO del avatar; los pies = centro − media altura.
        const feetY = this.holder.position.y - this.rig.height / 2;
        while (this.trailAcc >= TRAIL_EMIT_DT) {
          this.trailAcc -= TRAIL_EMIT_DT;
          this.motionTrail.emit(this.holder.position.x, feetY, this.holder.position.z);
        }
      } else {
        this.trailAcc = 0;
      }
    }

    // Anim directa al AnimationDriver (el estado lo fija setAnim en cada upsert).
    this.rig.update(dt, this.driveState);

    // --- fundidos ---
    if (this.removing) {
      this.fade = Math.max(0, this.fade - dt / FADE_TIME);
      if (this.fade <= 0) {
        this.dead = true;
      }
    } else {
      this.fade = Math.min(1, this.fade + dt / FADE_TIME);
    }
    for (const m of this.materials) m.opacity = this.fade;

    // --- etiqueta: opacidad por distancia a cámara, se desvanece a >20 u ---
    if (this.label) {
      const d = cameraPos.distanceTo(this.holder.position);
      const distFade = 1 - THREE.MathUtils.smoothstep(d, LABEL_NEAR, LABEL_FAR);
      (this.label.material as THREE.SpriteMaterial).opacity = this.fade * distFade;
    }

    // --- partícula de aparición/desaparición ---
    if (this.puff && this.puffLife > 0) {
      this.puffLife -= dt;
      const k = 1 - this.puffLife / 0.5;
      this.puff.position.copy(this.holder.position);
      this.puff.scale.setScalar(0.4 + k * 1.6);
      (this.puff.material as THREE.PointsMaterial).opacity = Math.max(0, 0.6 * (1 - k));
      if (this.puffLife <= 0) this.puff.visible = false; // no gastar draw call ya apagada
    }
  }

  /** Estado de conducción actual (se fija en push vía la última anim recibida). */
  private driveState: AvatarDriveState = driveStateFor("idle");

  /** Actualiza la animación objetivo (llamado desde el orquestador con el string). */
  setAnim(anim: string): void {
    this.curAnim = anim;
    this.driveState = driveStateFor(anim);
  }

  /** Reproduce un EMOTE en el rig del remoto (se mezcla y vuelve a idle). */
  playEmote(emote: string): void {
    if (this.dead) return;
    this.rig.playEmote(emote);
  }

  // ---- etiqueta MSDF-free: sprite de canvas 2D ----

  private setLabel(name?: string): void {
    if (this.label) {
      this.holder.remove(this.label);
      (this.label.material as THREE.SpriteMaterial).dispose();
      this.labelTex?.dispose();
      this.label = undefined;
      this.labelTex = undefined;
    }
    if (!name) return;

    const canvas = document.createElement("canvas");
    const pad = 16;
    const font = '600 40px "Chakra Petch", system-ui, sans-serif';
    const ctx = canvas.getContext("2d")!;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(name).width) + pad * 2;
    const h = 64;
    canvas.width = w;
    canvas.height = h;
    // Redibuja tras redimensionar (limpia el buffer).
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    // Cápsula translúcida de fondo.
    ctx.fillStyle = "rgba(14,21,18,0.55)";
    this.roundRect(ctx, 2, 8, w - 4, h - 16, 14);
    ctx.fill();
    // Texto claro.
    ctx.fillStyle = "#eef3ee";
    ctx.fillText(name, w / 2, h / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    // Tamaño discreto en unidades de mundo, proporción del canvas.
    const worldH = 0.42;
    sprite.scale.set((worldH * w) / h, worldH, 1);
    sprite.position.set(0, this.rig.height / 2 + 0.55, 0);
    sprite.renderOrder = 3;
    this.holder.add(sprite);
    this.label = sprite;
    this.labelTex = tex;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private spawnPuff(scene: THREE.Scene): void {
    const count = 14;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.5;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 1.4;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.5,
      map: makeSoftCircleTexture("rgba(227,176,99,0.9)"),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    });
    this.puff = new THREE.Points(geo, mat);
    this.puff.frustumCulled = false;
    this.puffLife = 0.5;
    scene.add(this.puff);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.holder);
    if (this.puff) {
      scene.remove(this.puff);
      this.puff.geometry.dispose();
      (this.puff.material as THREE.PointsMaterial).map?.dispose();
      (this.puff.material as THREE.Material).dispose();
    }
    if (this.label) {
      (this.label.material as THREE.SpriteMaterial).dispose();
      this.labelTex?.dispose();
    }
    this.rig.dispose();
  }
}

/**
 * Pool de avatares remotos (cap 32) con interpolación suave. El orquestador de
 * red inyecta estados vía `upsert`; el pool los interpola con un buffer de ~120
 * ms (posición por lerp, yaw por slerp) y conduce la animación al AnimationDriver.
 */
export class RemotePlayers {
  private map = new Map<string, RemoteAvatar>();
  private _camPos = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    /** Estela compartida (equipo Vuelo): cada remoto emite motas en este pool. */
    private motionTrail?: MotionEmitter,
  ) {}

  /** Nº de remotos vivos (para el smoke test). */
  get count(): number {
    return this.map.size;
  }

  upsert(id: string, s: RemoteState, now: number): void {
    let a = this.map.get(id);
    if (!a) {
      if (this.map.size >= MAX_REMOTES) return; // cap: descarta silenciosamente
      a = new RemoteAvatar(this.scene, this.motionTrail);
      this.map.set(id, a);
    }
    a.setAnim(s.anim);
    a.setArchetype(s.archetype);
    a.push(s, now);
  }

  remove(id: string): void {
    this.map.get(id)?.beginRemove();
  }

  /** El avatar remoto `id` reproduce un emote (si existe en el pool). */
  playEmote(id: string, emote: string): void {
    this.map.get(id)?.playEmote(emote);
  }

  /** Posición interpolada actual del holder de un remoto (para QA/__PAQO__). */
  debugHolderPosition(id: string): THREE.Vector3 | null {
    const a = this.map.get(id);
    return a ? a.holder.position.clone() : null;
  }

  update(dt: number, now: number, camera: THREE.Camera): void {
    const renderTime = now - INTERP_DELAY;
    camera.getWorldPosition(this._camPos);
    for (const [id, a] of this.map) {
      a.update(dt, renderTime, this._camPos);
      if (a.isDead()) {
        a.dispose(this.scene);
        this.map.delete(id);
      }
    }
  }

  dispose(): void {
    for (const a of this.map.values()) a.dispose(this.scene);
    this.map.clear();
  }
}
