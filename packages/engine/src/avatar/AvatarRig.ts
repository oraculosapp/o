import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { AnimationDriver } from "./AnimationDriver";
import { TintController, toToonMaterial, avatarToonRamp, type HueBand } from "./tint";
import type { AvatarDriveState, IAvatarRig, PropSocket, TintZone } from "./types";

export interface AvatarRigOptions {
  /** Ruta del decoder DRACO (asume `apps/web/public/draco/`). Default `/draco/`. */
  dracoDecoderPath?: string;
  /** Rampa toon a usar (default: la de 3 bandas de la casa). */
  gradientMap?: THREE.DataTexture;
  /** Velocidades de referencia para sincronizar los clips walk/run con la velocidad real. */
  walkRefSpeed?: number;
  runRefSpeed?: number;
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
const HAIR_KW = ["hair", "pelo", "cabello"];
const SKIN_KW = ["skin", "piel", "face", "cara", "body", "cuerpo", "head", "cabeza", "eye", "ojo"];
const SECONDARY_KW = ["secondary", "accent", "trim", "belt", "boot", "glove", "sleeve", "detail", "prop"];

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

  private mixer: THREE.AnimationMixer;
  private driver: AnimationDriver;
  private tint = new TintController();
  private sockets: Record<PropSocket, THREE.Object3D>;
  private ramp: THREE.DataTexture;
  private ownRamp: boolean;
  private disposed = false;

  private constructor(gltf: GLTF, opts?: AvatarRigOptions) {
    this.root = gltf.scene;
    this.ownRamp = !opts?.gradientMap;
    this.ramp = opts?.gradientMap ?? avatarToonRamp();

    // Altura real del modelo (para que el controller coloque el centro correctamente).
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    box.getSize(size);
    this.height = size.y || 1.8;

    this.convertMaterials();
    this.sockets = this.buildSockets();

    this.mixer = new THREE.AnimationMixer(this.root);
    this.driver = new AnimationDriver(this.mixer, gltf.animations, {
      walkRefSpeed: opts?.walkRefSpeed,
      runRefSpeed: opts?.runRefSpeed,
    });
  }

  static async load(url: string, opts?: AvatarRigOptions): Promise<AvatarRig> {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(opts?.dracoDecoderPath ?? "/draco/");
    loader.setDRACOLoader(draco);
    try {
      const gltf = await loader.loadAsync(url);
      return new AvatarRig(gltf, opts);
    } finally {
      draco.dispose();
    }
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
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const converted = mats.map((m) => {
        let toon = seen.get(m);
        if (!toon) {
          toon = toToonMaterial(m, this.ramp);
          seen.set(m, toon);
          // Nombre para clasificar: el del material o, si viene vacío, el del mesh.
          const srcName = (m.name || mesh.name || "").toLowerCase();
          toonList.push({ mat: toon, srcName });
          m.dispose();
        }
        return toon;
      });
      mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
    });

    // Estrategia de tinte según nº de materiales.
    const tintable = toonList.filter((t) => !SKIN_KW.some((k) => t.srcName.includes(k)));
    if (toonList.length <= 1) {
      // Un solo material con todo horneado → máscara de hue (best-effort).
      if (toonList[0]) this.tint.patchHueMask(toonList[0].mat, DEFAULT_HUE_BANDS);
    } else {
      // Varios materiales → asigna zona por material (ruta precisa).
      let unmatched = 0;
      for (const { mat, srcName } of tintable) {
        const zone = this.guessZone(srcName, unmatched);
        if (zone === null) {
          unmatched++;
          this.tint.patchZone(mat, unmatched === 1 ? "primary" : "secondary");
        } else {
          this.tint.patchZone(mat, zone);
        }
      }
    }
  }

  /** Clasifica un material en una zona por palabras clave; null si no hay match. */
  private guessZone(name: string, _unmatchedSoFar: number): TintZone | null {
    if (HAIR_KW.some((k) => name.includes(k))) return "hair";
    if (SECONDARY_KW.some((k) => name.includes(k))) return "secondary";
    if (name.includes("primary") || name.includes("cloth") || name.includes("ropa")) return "primary";
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
    this.driver.update(dt, state);
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
    this.driver.dispose();
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
