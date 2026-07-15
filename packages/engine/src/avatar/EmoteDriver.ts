import * as THREE from "three";

/**
 * EmoteDriver — animador PROCEDURAL de EMOTES para esqueletos humanoides Mixamo
 * (el avatar "nube" y cualquier GLB con huesos mixamorig:). Hecho 100% en código
 * (consistencia de la casa, sin packs externos).
 *
 * Emotes: "dance1" (caderas + brazos alternos), "dance2" (giro + brazos arriba),
 * "wave" (saludo), "spin" (giro completo), "jump-cheer" (saltito con brazos).
 *
 * Cada emote es un one-shot que ARRANCA y VUELVE a la pose de reposo con una
 * envolvente suave (ease-in/out), así se MEZCLA con la locomoción/idle sin pop:
 * mientras un emote está activo, ÉL conduce los huesos (la locomoción cede); al
 * terminar, la locomoción retoma desde el reposo. Rota el hueso raíz (Hips) para
 * girar/saltar TODO el cuerpo (los demás huesos cuelgan de él).
 *
 * Estrategia de ejes idéntica a {@link ProceduralLocomotion}: se mide la
 * orientación de reposo de cada hueso y se convierten los ejes de MUNDO
 * (sagital=X, vertical=Y, lateral=Z) al espacio LOCAL, para que las rotaciones
 * caigan siempre en el plano correcto sea cual sea la convención del export.
 */

/** Ids de emote soportados. */
export type EmoteId = "dance1" | "dance2" | "wave" | "spin" | "jump-cheer";

/** Lista blanca de emotes (para validar broadcasts M-5 y pintar el menú). */
export const EMOTE_IDS: readonly EmoteId[] = [
  "dance1",
  "dance2",
  "wave",
  "spin",
  "jump-cheer",
] as const;

/** ¿Es `id` un emote válido? */
export function isEmoteId(id: string): id is EmoteId {
  return (EMOTE_IDS as readonly string[]).includes(id);
}

/** Duración (s) de cada emote. */
const DURATION: Record<EmoteId, number> = {
  dance1: 2.6,
  dance2: 2.8,
  wave: 2.0,
  spin: 1.5,
  "jump-cheer": 1.2,
};

type BoneKey =
  | "hips" | "spine" | "spine1" | "spine2" | "neck" | "head"
  | "leftShoulder" | "leftArm" | "leftForeArm"
  | "rightShoulder" | "rightArm" | "rightForeArm"
  | "leftUpLeg" | "leftLeg" | "rightUpLeg" | "rightLeg";

interface BoneNode {
  bone: THREE.Bone;
  restQuat: THREE.Quaternion;
  restPos: THREE.Vector3;
  sagittal: THREE.Vector3;
  vertical: THREE.Vector3;
  lateral: THREE.Vector3;
}

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

/** Normaliza un nombre de hueso Mixamo → clave canónica minúscula. */
function norm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^mixamorig[:_]?/, "")
    .replace(/[_\s]?end$/, "")
    .replace(/_\d+$/, "")
    .replace(/[:_\s]/g, "");
}

const NAME_TO_KEY: Record<string, BoneKey> = {
  hips: "hips", spine: "spine", spine1: "spine1", spine2: "spine2", neck: "neck", head: "head",
  leftshoulder: "leftShoulder", leftarm: "leftArm", leftforearm: "leftForeArm",
  rightshoulder: "rightShoulder", rightarm: "rightArm", rightforearm: "rightForeArm",
  leftupleg: "leftUpLeg", leftleg: "leftLeg", rightupleg: "rightUpLeg", rightleg: "rightLeg",
};

export class EmoteDriver {
  /** ¿Se mapearon los huesos mínimos (cadera + 2 brazos)? */
  readonly mapped: boolean;

  private nodes = new Map<BoneKey, BoneNode>();
  private active: EmoteId | null = null;
  private t = 0;
  private dur = 0;

  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();
  private hipsUpAxis = new THREE.Vector3(0, 1, 0);

  private constructor(root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const bones: THREE.Bone[] = [];
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });

    const worldQ = new THREE.Quaternion();
    const invQ = new THREE.Quaternion();
    for (const bone of bones) {
      const key = NAME_TO_KEY[norm(bone.name)];
      if (!key || this.nodes.has(key)) continue;
      bone.getWorldQuaternion(worldQ);
      invQ.copy(worldQ).invert();
      this.nodes.set(key, {
        bone,
        restQuat: bone.quaternion.clone(),
        restPos: bone.position.clone(),
        sagittal: WORLD_X.clone().applyQuaternion(invQ).normalize(),
        vertical: WORLD_Y.clone().applyQuaternion(invQ).normalize(),
        lateral: WORLD_Z.clone().applyQuaternion(invQ).normalize(),
      });
    }

    const hips = this.nodes.get("hips");
    if (hips && hips.bone.parent) {
      (hips.bone.parent as THREE.Object3D).getWorldQuaternion(worldQ);
      invQ.copy(worldQ).invert();
      this.hipsUpAxis = WORLD_Y.clone().applyQuaternion(invQ).normalize();
    }

    this.mapped = this.nodes.has("hips") && this.nodes.has("leftArm") && this.nodes.has("rightArm");
  }

  /** Crea el driver si el esqueleto mapea (cadera + 2 brazos); si no, `null`. */
  static tryCreate(root: THREE.Object3D): EmoteDriver | null {
    const d = new EmoteDriver(root);
    return d.mapped ? d : null;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /** Arranca un emote (reinicia si ya había uno). No-op si el esqueleto no mapea. */
  play(id: EmoteId): void {
    if (!this.mapped) return;
    this.active = id;
    this.t = 0;
    this.dur = DURATION[id];
  }

  stop(): void {
    if (!this.active) return;
    this.resetToRest();
    this.active = null;
  }

  /** Avanza el emote y aplica su pose. Cuando termina, deja los huesos en reposo. */
  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    if (this.t >= this.dur) {
      this.resetToRest();
      this.active = null;
      return;
    }
    this.resetToRest();
    this.applyPose(this.active, this.t, this.envelope(this.t, this.dur));
  }

  // ---- poses ----

  /** Envolvente ease-in/out 0..1 (arranca y vuelve al reposo sin pop). */
  private envelope(t: number, dur: number): number {
    const inW = THREE.MathUtils.smoothstep(t, 0, 0.18);
    const outW = 1 - THREE.MathUtils.smoothstep(t, dur - 0.28, dur);
    return inW * outW;
  }

  private applyPose(id: EmoteId, t: number, env: number): void {
    switch (id) {
      case "dance1": {
        const beat = t * 6;
        this.rot("hips", "lateral", Math.sin(beat) * 0.2 * env);
        this.rot("hips", "vertical", Math.sin(beat * 0.5) * 0.18 * env);
        this.hipsBob(Math.abs(Math.sin(beat)) * 0.05 * env);
        // Brazos alternos bombeando arriba.
        this.rot("leftArm", "sagittal", (-1.1 + Math.sin(beat) * 0.6) * env);
        this.rot("rightArm", "sagittal", (-1.1 - Math.sin(beat) * 0.6) * env);
        this.rot("leftForeArm", "sagittal", -0.5 * env);
        this.rot("rightForeArm", "sagittal", -0.5 * env);
        this.rot("spine1", "vertical", Math.sin(beat * 0.5) * 0.12 * env);
        this.rot("head", "lateral", Math.sin(beat) * 0.1 * env);
        break;
      }
      case "dance2": {
        const beat = t * 5;
        // Brazos ARRIBA en V, ondeando.
        this.rot("leftArm", "sagittal", (-2.2 + Math.sin(beat) * 0.25) * env);
        this.rot("rightArm", "sagittal", (-2.2 - Math.sin(beat) * 0.25) * env);
        this.rot("leftForeArm", "sagittal", -0.2 * env);
        this.rot("rightForeArm", "sagittal", -0.2 * env);
        // Giro/vaivén de caderas + bob.
        this.rot("hips", "vertical", Math.sin(t * 3) * 0.55 * env);
        this.rot("spine1", "vertical", -Math.sin(t * 3) * 0.2 * env);
        this.hipsBob(Math.abs(Math.sin(beat)) * 0.06 * env);
        break;
      }
      case "wave": {
        // Brazo derecho arriba, saludando; el resto quieto.
        this.rot("rightArm", "sagittal", -2.1 * env);
        this.rot("rightShoulder", "sagittal", -0.3 * env);
        this.rot("rightForeArm", "sagittal", (-0.3 + Math.sin(t * 8) * 0.5) * env);
        this.rot("head", "lateral", 0.12 * env);
        this.rot("spine", "lateral", -0.05 * env);
        break;
      }
      case "spin": {
        // Vuelta completa (no lleva envolvente: 0 y 2π son la misma pose).
        const turn = THREE.MathUtils.smoothstep(t, 0, this.dur) * Math.PI * 2;
        this.rot("hips", "vertical", turn);
        // Brazos un poco abiertos durante el giro.
        this.rot("leftArm", "sagittal", -0.6 * env);
        this.rot("rightArm", "sagittal", -0.6 * env);
        this.hipsBob(Math.sin(t / this.dur * Math.PI) * 0.05);
        break;
      }
      case "jump-cheer": {
        const hopN = Math.sin((t / this.dur) * Math.PI); // 0→1→0
        this.hipsBob(hopN * 0.34);
        // Brazos arriba.
        this.rot("leftArm", "sagittal", -2.0 * env);
        this.rot("rightArm", "sagittal", -2.0 * env);
        // Piernas recogidas en el ápice.
        this.rot("leftUpLeg", "sagittal", 0.4 * hopN);
        this.rot("rightUpLeg", "sagittal", 0.4 * hopN);
        this.rot("leftLeg", "sagittal", -0.7 * hopN);
        this.rot("rightLeg", "sagittal", -0.7 * hopN);
        break;
      }
    }
  }

  // ---- utilidades ----

  private resetToRest(): void {
    for (const n of this.nodes.values()) {
      n.bone.quaternion.copy(n.restQuat);
    }
    const hips = this.nodes.get("hips");
    if (hips) hips.bone.position.copy(hips.restPos);
  }

  private rot(key: BoneKey, axis: "sagittal" | "vertical" | "lateral", angle: number): void {
    if (angle === 0) return;
    const n = this.nodes.get(key);
    if (!n) return;
    this._q.setFromAxisAngle(n[axis], angle);
    n.bone.quaternion.multiply(this._q);
  }

  /** Sube la cadera `amount` u a lo largo del "arriba" de mundo (saltos/bob). */
  private hipsBob(amount: number): void {
    if (amount === 0) return;
    const hips = this.nodes.get("hips");
    if (!hips) return;
    this._v.copy(hips.restPos).addScaledVector(this.hipsUpAxis, amount);
    hips.bone.position.copy(this._v);
  }
}
