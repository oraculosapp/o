import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { AnimationDriver, type Locomotion } from "./AnimationDriver";
import { ProceduralLocomotion, type LocomotionQA } from "./ProceduralLocomotion";
import { EmoteDriver, isEmoteId } from "./EmoteDriver";
import { TintController, toToonMaterial, avatarToonRamp, type HueBand } from "./tint";
import type { AvatarDriveState, IAvatarRig, PropSocket, TintZone } from "./types";

/** Fuente mínima que necesita el rig: escena skinned + clips (subconjunto de GLTF). */
export type AvatarSource = Pick<GLTF, "scene" | "animations">;

export interface AvatarRigOptions {
  /** Ruta del decoder DRACO (asume `apps/web/public/draco/`). Default `/draco/`. */
  dracoDecoderPath?: string;
  /** Rampa toon a usar (default: la de 3 bandas de la casa). */
  gradientMap?: THREE.DataTexture;
  /** Velocidades de referencia para sincronizar los clips walk/run con la velocidad real. */
  walkRefSpeed?: number;
  runRefSpeed?: number;
  /**
   * Altura objetivo (u) para normalizar modelos que vengan a otra escala. Si la
   * altura medida cae fuera de `[1.4, 2.2]` (p.ej. un Mixamo exportado a ~1.16 u),
   * el rig escala `root` uniformemente hasta esta altura para que el controller lo
   * coloque bien (eyeHeight = height/2). Default 1.7. Poner `0` desactiva.
   */
  targetHeight?: number;
  /**
   * Si `false`, NO libera los materiales fuente al convertirlos a toon. Necesario
   * cuando la escena viene de un clon compartido (SkeletonUtils.clone) cuyos
   * materiales/texturas comparten otras instancias (ver AvatarGLTFCache).
   * Default `true` (carga única, dueña de sus materiales).
   */
  disposeSource?: boolean;
}

/** Bandas de hue por defecto para modelos de UN solo material (estrategia hueMask).
 *  Best-effort: cubren tres franjas del círculo de color. El integrador las
 *  afinará por arquetipo cuando existan los GLB reales de Tripo3D. */
const DEFAULT_HUE_BANDS: HueBand[] = [
  { zone: "primary", hue: 0.6, range: 0.16 }, // azules/violetas (ropa fría típica)
  { zone: "secondary", hue: 0.1, range: 0.14 }, // naranjas/tierra (acentos cálidos)
  { zone: "hair", hue: 0.08, range: 0.1 }, // marrones (pelo)
];

/** Palabras clave para clasificar materiales/huesos por zona o socket. */
const HAIR_KW = ["hair", "pelo", "cabello", "beard", "barba"];
const SKIN_KW = ["skin", "piel", "face", "cara", "body", "cuerpo", "head", "cabeza", "eye", "ojo"];
const ACCENT_KW = ["accent", "acento", "detail", "detalle", "trim", "metal", "gold", "oro", "neon", "gem", "gema", "glow", "prop"];
const SECONDARY_KW = ["secondary", "secundario", "pant", "trouser", "leg", "pierna", "lower", "boot", "shoe", "zapato", "belt", "glove", "sleeve"];

/**
 * Adopta un GLB skinned (arquetipo Tripo3D) y expone el contrato `IAvatarRig`.
 *
 * Uso:
 * ```ts
 * const rig = await AvatarRig.load("/assets/avatars/hacker-m.glb");
 * scene.add(rig.root);
 * // cada frame: rig.update(dt, { speed, maxSpeed, grounded, jumping });
 * rig.setTint({ primary: new THREE.Color("#8ace3b") });
 * ```
 *
 * Carga async: usar la fábrica estática {@link AvatarRig.load}.
 */
export class AvatarRig implements IAvatarRig {
  readonly root: THREE.Object3D;
  readonly height: number;

  private mixer?: THREE.AnimationMixer;
  private driver?: AnimationDriver;
  /** Animador procedural cuando el GLB no trae clips de locomoción utilizables. */
  private loco?: ProceduralLocomotion;
  /** Animador procedural de emotes (one-shot que se mezcla y vuelve a idle). */
  private emote?: EmoteDriver;
  private tint = new TintController();
  private sockets: Record<PropSocket, THREE.Object3D>;
  private ramp: THREE.DataTexture;
  private ownRamp: boolean;
  private disposeSourceMats: boolean;
  private disposed = false;

  private constructor(gltf: AvatarSource, opts?: AvatarRigOptions) {
    this.root = gltf.scene;
    this.ownRamp = !opts?.gradientMap;
    this.ramp = opts?.gradientMap ?? avatarToonRamp();
    this.disposeSourceMats = opts?.disposeSource !== false;

    // Altura CRUDA del modelo (pre-escala), para el bob procedural en unidades locales.
    const rawHeight = this.measureHeight();
    this.height = rawHeight;

    this.convertMaterials();
    this.sockets = this.buildSockets();

    // ── Elección de motor de locomoción ──────────────────────────────────────
    // Si el GLB trae clips walk/run REALES (duración > 0.2 s) → AnimationDriver.
    // Si NO (p.ej. sólo poses estáticas) pero el esqueleto mapea como humanoide
    // Mixamo → ProceduralLocomotion. Los clips-pose quedan como pose base (no se
    // reproducen: el procedural es dueño de los huesos).
    const usableClips = AvatarRig.hasUsableLocomotion(gltf.animations);
    const loco = usableClips ? null : ProceduralLocomotion.tryCreate(this.root);
    if (loco) {
      this.loco = loco;
      this.locoClipNames = gltf.animations.map((c) => c.name);
    } else {
      this.mixer = new THREE.AnimationMixer(this.root);
      this.driver = new AnimationDriver(this.mixer, gltf.animations, {
        walkRefSpeed: opts?.walkRefSpeed,
        runRefSpeed: opts?.runRefSpeed,
      });
    }

    // Emotes procedurales (si el esqueleto mapea como humanoide Mixamo).
    this.emote = EmoteDriver.tryCreate(this.root) ?? undefined;

    // ── Normalización de escala ──────────────────────────────────────────────
    // Modelos fuera de rango humano (Mixamo suele venir a ~1.16 u) se escalan a la
    // altura objetivo para que el controller (eyeHeight = height/2) los ancle bien.
    const target = opts?.targetHeight ?? 1.7;
    if (target > 0 && (rawHeight < 1.4 || rawHeight > 2.2)) {
      const s = target / rawHeight;
      this.root.scale.multiplyScalar(s);
      this.root.updateMatrixWorld(true);
      this.height = this.measureHeight();
    }
  }

  private measureHeight(): number {
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    box.getSize(size);
    return size.y || 1.8;
  }

  /** ¿Hay algún clip de locomoción REAL (walk/run con duración animable)? */
  private static hasUsableLocomotion(clips: THREE.AnimationClip[]): boolean {
    return clips.some((c) => c.duration > 0.2 && /walk|run|locomo|caminar|correr/i.test(c.name));
  }

  static async load(url: string, opts?: AvatarRigOptions): Promise<AvatarRig> {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(opts?.dracoDecoderPath ?? "/draco/");
    loader.setDRACOLoader(draco);
    // Los GLB optimizados salen con EXT_meshopt_compression (ver
    // tools/assets/optimize-avatars.mjs); registrar el decoder es imprescindible.
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      const gltf = await loader.loadAsync(url);
      return new AvatarRig(gltf, opts);
    } finally {
      draco.dispose();
    }
  }

  /**
   * Adopta una escena ya cargada/clonada (no vuelve a hacer I/O). La usa
   * {@link AvatarGLTFCache} para instanciar múltiples avatares (remotos) desde un
   * único GLTF cacheado vía `SkeletonUtils.clone`, sin recargar de red.
   */
  static fromGLTF(source: AvatarSource, opts?: AvatarRigOptions): AvatarRig {
    return new AvatarRig(source, opts);
  }

  /**
   * Diagnóstico de clips (para /dev/avatar): nombres reales que trajo el GLB y a
   * qué locomoción quedó mapeado cada uno tras el mapeo difuso del AnimationDriver.
   */
  get clipInfo(): { names: string[]; mapping: Record<Locomotion, string | null> } {
    if (this.driver) return { names: this.driver.clipNames, mapping: this.driver.mapping };
    // Modo procedural: no hay clips utilizables; reporta el origen y los huesos.
    const names = this.locoClipNames;
    const tag = "procedural";
    return { names, mapping: { idle: tag, walk: tag, run: tag, jump: tag } };
  }

  /** Nombres de clips estáticos que trajo el GLB (informativo en modo procedural). */
  private locoClipNames: string[] = [];

  /** ¿Qué motor conduce la locomoción? Para diagnóstico del laboratorio. */
  get locomotionSource(): "clips" | "procedural" {
    return this.loco ? "procedural" : "clips";
  }

  /** Métricas de QA del animador procedural (o `null` si conduce por clips). */
  get locomotionQA(): LocomotionQA | null {
    return this.loco?.getQA() ?? null;
  }

  // ---- conversión de materiales + tinte ----

  /** Convierte todos los materiales a toon y decide la estrategia de tinte. */
  private convertMaterials(): void {
    // Recolecta materiales únicos y su mesh dueño (para clasificarlos por nombre).
    const seen = new Map<THREE.Material, THREE.MeshToonMaterial>();
    const toonList: { mat: THREE.MeshToonMaterial; srcName: string }[] = [];

    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Los materiales de la casa son `MeshToonMaterial` (con luz): necesitan
      // NORMALES. Los GLB `KHR_materials_unlit` (p.ej. hacker-girl, con sombreado
      // horneado en la textura) suelen venir SIN normales → renderizarían negros.
      // Las generamos en la pose de bind si faltan (idempotente; ~7k tris, trivial).
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const converted = mats.map((m) => {
        let toon = seen.get(m);
        if (!toon) {
          toon = toToonMaterial(m, this.ramp);
          seen.set(m, toon);
          // Nombre para clasificar: el del material o, si viene vacío, el del mesh.
          const srcName = (m.name || mesh.name || "").toLowerCase();
          toonList.push({ mat: toon, srcName });
          // En modo clon compartido no liberamos: los materiales/texturas fuente
          // los comparten otras instancias (se liberan al vaciar la caché).
          if (this.disposeSourceMats) m.dispose();
        }
        return toon;
      });
      mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
    });

    // Estrategia de tinte según nº de materiales.
    if (toonList.length <= 1) {
      // Un solo material con todo horneado → máscara de hue (best-effort).
      if (toonList[0]) this.tint.patchHueMask(toonList[0].mat, DEFAULT_HUE_BANDS);
    } else {
      // Varios materiales → asigna zona por material (ruta precisa). Con los GLB
      // generados (materiales NOMBRADOS primary/secondary/hair/skin/accent) el
      // acierto es exacto; con GLB arbitrarios, heurística + reparto por orden.
      let unmatched = 0;
      for (const { mat, srcName } of toonList) {
        const zone = this.guessZone(srcName);
        if (zone === null) {
          unmatched++;
          this.tint.patchZone(mat, unmatched === 1 ? "primary" : "secondary");
        } else {
          this.tint.patchZone(mat, zone);
        }
      }
    }
  }

  /** Clasifica un material en una de las 5 zonas por palabras clave; null si no hay match. */
  private guessZone(name: string): TintZone | null {
    // Avatar "nube": el cuerpo (material "body") ES la zona de tinte principal;
    // los ojos ("eyes") van a su propia zona (negro, sin tinte primary).
    if (name === "body") return "primary";
    if (name === "eyes") return "accent";
    if (name === "hair" || HAIR_KW.some((k) => name.includes(k))) return "hair";
    if (name === "skin" || SKIN_KW.some((k) => name.includes(k))) return "skin";
    if (name === "accent" || ACCENT_KW.some((k) => name.includes(k))) return "accent";
    if (name === "secondary" || SECONDARY_KW.some((k) => name.includes(k))) return "secondary";
    if (name === "primary" || name.includes("cloth") || name.includes("ropa") || name.includes("shirt") || name.includes("coat")) return "primary";
    return null; // sin pista → el llamador reparte primary/secondary por orden
  }

  // ---- sockets de props ----

  private buildSockets(): Record<PropSocket, THREE.Object3D> {
    const bones: THREE.Bone[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    const findBone = (...preds: ((n: string) => boolean)[]): THREE.Bone | undefined => {
      for (const pred of preds) {
        const b = bones.find((bn) => pred(bn.name.toLowerCase()));
        if (b) return b;
      }
      return undefined;
    };
    const isRight = (n: string) => /(right|_r\b|\.r\b|r$)/.test(n) || n.includes("right");
    const isLeft = (n: string) => /(left|_l\b|\.l\b|l$)/.test(n) || n.includes("left");

    const handRBone = findBone((n) => n.includes("hand") && isRight(n), (n) => n.includes("wrist") && isRight(n));
    const handLBone = findBone((n) => n.includes("hand") && isLeft(n), (n) => n.includes("wrist") && isLeft(n));
    const backBone = findBone((n) => n.includes("spine"), (n) => n.includes("chest"), (n) => n.includes("back"));

    const h = this.height;
    const socket = (bone: THREE.Bone | undefined, fallbackPos: THREE.Vector3): THREE.Object3D => {
      const s = new THREE.Object3D();
      if (bone) {
        bone.add(s); // sigue la animación
      } else {
        s.position.copy(fallbackPos);
        this.root.add(s); // estático relativo al avatar
      }
      return s;
    };

    return {
      handR: socket(handRBone, new THREE.Vector3(0.3 * (h / 1.8), 0.9 * (h / 1.8), 0.1)),
      handL: socket(handLBone, new THREE.Vector3(-0.3 * (h / 1.8), 0.9 * (h / 1.8), 0.1)),
      back: socket(backBone, new THREE.Vector3(0, 1.1 * (h / 1.8), -0.18)),
    };
  }

  // ---- IAvatarRig ----

  update(dt: number, state: AvatarDriveState): void {
    if (this.disposed) return;
    // Mientras un emote está activo, ÉL conduce los huesos; la locomoción cede y
    // retoma al terminar (los huesos vuelven al reposo con la envolvente del emote).
    if (this.emote?.isActive) {
      this.emote.update(dt);
      return;
    }
    if (this.loco) this.loco.update(dt, state);
    else this.driver?.update(dt, state);
  }

  playEmote(id: string): void {
    if (this.disposed || !this.emote) return;
    if (isEmoteId(id)) this.emote.play(id);
  }

  setTint(palette: Partial<Record<TintZone, THREE.Color>>): void {
    for (const zone of Object.keys(palette) as TintZone[]) {
      const c = palette[zone];
      if (c) this.tint.set(zone, c);
    }
  }

  attachProp(mesh: THREE.Object3D, socket: PropSocket): void {
    this.sockets[socket].add(mesh);
  }

  dispose(): void {
    this.disposed = true;
    this.driver?.dispose();
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    if (this.ownRamp) this.ramp.dispose();
  }
}
