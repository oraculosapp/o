import * as THREE from "three";

/**
 * ExpressiveEyes — ojos EXPRESIVOS por código para el avatar "nube" (y cualquier
 * GLB con hueso `mixamorig:Head`). Los ojos ya NO se hornean en la malla del GLB
 * (eran estáticos): aquí se crean dos meshes de ojo (esferas achatadas negras)
 * anclados al hueso de la cabeza en las posiciones que tenían en el GLB previo, y
 * se DEFORMAN/ESCALAN por código según el estado de locomoción/emote:
 *
 *   · idle : ojos normales + PARPADEO aleatorio cada 3-6 s (escala Y→0.08, 120 ms).
 *   · walk : normales (con parpadeo).
 *   · run  : entrecerrados decididos (escala Y ~0.6).
 *   · jump : MUY abiertos (escala 1.3).
 *   · fly  : abiertos + BRILLO (escala 1.25 + emissive).
 *   · dance: felices — "ojos sonrientes" ∩ (segunda geometría de media luna).
 *
 * Al ir anclados al hueso `Head`, siguen la animación de la cabeza (idle, marcha,
 * emotes) sin cálculo extra. Las transiciones entre expresiones se amortiguan
 * (lerp ~120 ms) para que nunca haya saltos. Cero allocations en el bucle.
 *
 * Anclaje robusto a convención de export: en vez de derivar a mano la transform
 * (yup + escala del rig + bind), se computa la posición de cada ojo en el espacio
 * LOCAL del hueso `Head` a partir de su coordenada de MUNDO en la pose de reposo
 * (`root.localToWorld` → `head.worldToLocal`), y se orienta el grupo del ojo para
 * que mire al frente del avatar (−Z) sea cual sea la orientación Mixamo del hueso.
 */

/** Estados de expresión que los ojos saben pintar (derivados del anim/estado). */
export type EyeState = "idle" | "walk" | "run" | "jump" | "fly" | "dance";

/**
 * Coordenadas de los ojos en el GLB previo (Blender Z-up, cara a +Y, lado
 * izquierdo en +X): `location=(±0.135, 0.325, 1.20)`. El export glTF (+Y up)
 * convierte Blender (x, y, z) → three (x, z, −y), así que en el espacio local del
 * root three quedan en (±0.135, 1.20, −0.325). El radio base y la elipse achatada
 * calcan el `add_eyes` del generate.py: esfera r=0.052 escalada (ancho, alto,
 * fondo) = (1.0, 1.15, 0.62) en ejes three.
 */
const EYE_BLENDER_XYZ: readonly [number, number, number][] = [
  [0.135, 0.325, 1.2],
  [-0.135, 0.325, 1.2],
];
const EYE_RADIUS = 0.052;
/** Escala elipse base (ancho X, alto Y, fondo Z) — achatada contra la cara (−Z). */
const EYE_BASE = new THREE.Vector3(1.0, 1.15, 0.62);

/** Multiplicador de escala por estado (sobre {@link EYE_BASE}). */
const EXPR: Record<EyeState, THREE.Vector3> = {
  idle: new THREE.Vector3(1, 1, 1),
  walk: new THREE.Vector3(1, 1, 1),
  run: new THREE.Vector3(1, 0.6, 1), // entrecerrados
  jump: new THREE.Vector3(1.3, 1.3, 1.3), // muy abiertos
  fly: new THREE.Vector3(1.25, 1.25, 1.25), // abiertos + brillo
  dance: new THREE.Vector3(1, 1, 1), // usa geometría ∩ (round oculto)
};

/** Constante de damping (s) del blend de expresión (~120 ms). */
const BLEND_TAU = 0.11;
/** Parpadeo: intervalo aleatorio (s) y duración (s). */
const BLINK_MIN = 3;
const BLINK_MAX = 6;
const BLINK_DUR = 0.12;
/** Factor de cierre del parpadeo (escala Y en el pico). */
const BLINK_CLOSE = 0.08;
/** Intensidad emissive objetivo en vuelo (brillo). */
const FLY_GLOW = 0.9;

/** Normaliza un nombre de hueso Mixamo para reconocer la cabeza. */
function isHeadBone(raw: string): boolean {
  return (
    raw
      .toLowerCase()
      .replace(/^mixamorig[:_]?/, "")
      .replace(/[_\s]?end$/, "")
      .replace(/_\d+$/, "")
      .replace(/[:_\s]/g, "") === "head"
  );
}

interface EyeMeshes {
  round: THREE.Mesh; // ojo normal (elipse)
  arc: THREE.Mesh; // "∩" feliz (media luna)
}

export class ExpressiveEyes {
  /** ¿Se encontró la cabeza y se crearon los ojos? Si no, todo es no-op. */
  readonly applied: boolean;

  private eyes: EyeMeshes[] = [];
  private roundMat?: THREE.MeshToonMaterial;
  private arcMat?: THREE.MeshToonMaterial;

  // Blend de expresión.
  private cur = new THREE.Vector3(1, 1, 1); // multiplicador actual amortiguado
  private glow = 0; // emissiveIntensity actual amortiguado
  private state: EyeState = "idle";

  // Parpadeo (solo en idle/walk).
  private blinkTimer = BLINK_MIN;
  private blinking = false;
  private blinkT = 0;

  private _s = new THREE.Vector3();

  constructor(root: THREE.Object3D, ramp?: THREE.DataTexture) {
    root.updateMatrixWorld(true);

    let head: THREE.Bone | undefined;
    root.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && isHeadBone((o as THREE.Bone).name)) {
        head = o as THREE.Bone;
      }
    });
    if (!head) {
      this.applied = false;
      return;
    }

    // Materiales negros toon (misma familia de la casa). El emissive (apagado por
    // defecto) da el brillo del vuelo sin depender de luces.
    const mk = () => {
      const m = new THREE.MeshToonMaterial({ color: 0x141118 });
      if (ramp) m.gradientMap = ramp;
      m.emissive = new THREE.Color(0x66ccff);
      m.emissiveIntensity = 0;
      return m;
    };
    this.roundMat = mk();
    this.arcMat = mk();

    // Geometrías compartidas por ambos ojos (una esfera + una media luna).
    const sphere = new THREE.SphereGeometry(EYE_RADIUS, 16, 10);
    // Torus (arco 0..π = media luna ∩, abriendo hacia abajo → ojo feliz).
    const torus = new THREE.TorusGeometry(EYE_RADIUS * 0.95, EYE_RADIUS * 0.32, 6, 14, Math.PI);

    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    const headQ = head.getWorldQuaternion(new THREE.Quaternion());
    // Orientación local (respecto al hueso) que deja el grupo mirando al frente
    // del avatar: worldQuat(grupo) = rootQ ⇒ localQuat = inverse(headQ)·rootQ.
    const localQ = headQ.clone().invert().multiply(rootQ);

    for (const [bx, by, bz] of EYE_BLENDER_XYZ) {
      // Blender (bx,by,bz) → three root-local (bx, bz, −by).
      const rootLocal = new THREE.Vector3(bx, bz, -by);
      const world = root.localToWorld(rootLocal.clone());
      const local = head.worldToLocal(world.clone());

      const group = new THREE.Object3D();
      group.position.copy(local);
      group.quaternion.copy(localQ);
      head.add(group);

      const round = new THREE.Mesh(sphere, this.roundMat);
      round.scale.copy(EYE_BASE);
      const arc = new THREE.Mesh(torus, this.arcMat);
      // La media luna: plana contra la cara y del tamaño del ojo.
      arc.scale.set(EYE_BASE.x, EYE_BASE.y, 0.4);
      arc.visible = false;
      group.add(round);
      group.add(arc);
      this.eyes.push({ round, arc });
    }

    this.applied = true;
  }

  /** Avanza el parpadeo y aplica la expresión objetivo `state`. No-op si no aplicó. */
  update(dt: number, state: EyeState): void {
    if (!this.applied || dt <= 0) return;
    this.state = state;

    // Blend suave del multiplicador de escala y del brillo hacia el objetivo.
    const target = EXPR[state];
    const k = 1 - Math.exp(-dt / BLEND_TAU);
    this.cur.lerp(target, k);
    const glowTarget = state === "fly" ? FLY_GLOW : 0;
    this.glow += (glowTarget - this.glow) * k;

    // Parpadeo solo en estados de ojos "normales" (idle/walk).
    const canBlink = state === "idle" || state === "walk";
    let blinkY = 1;
    if (canBlink) {
      this.blinkTimer -= dt;
      if (!this.blinking && this.blinkTimer <= 0) {
        this.blinking = true;
        this.blinkT = 0;
      }
      if (this.blinking) {
        this.blinkT += dt;
        const p = this.blinkT / BLINK_DUR;
        if (p >= 1) {
          this.blinking = false;
          this.blinkTimer = THREE.MathUtils.lerp(BLINK_MIN, BLINK_MAX, Math.random());
        } else {
          // Triángulo 0→1→0: cerrado en el centro del parpadeo.
          const tri = 1 - Math.abs(2 * p - 1);
          blinkY = THREE.MathUtils.lerp(1, BLINK_CLOSE, tri);
        }
      }
    } else {
      this.blinking = false;
    }

    // Modo feliz (dance): media luna ∩ visible, ojo redondo oculto.
    const happy = state === "dance";

    for (const { round, arc } of this.eyes) {
      round.visible = !happy;
      arc.visible = happy;
      this._s.set(
        EYE_BASE.x * this.cur.x,
        EYE_BASE.y * this.cur.y * blinkY,
        EYE_BASE.z * this.cur.z,
      );
      round.scale.copy(this._s);
    }
    if (this.roundMat) this.roundMat.emissiveIntensity = this.glow;
    if (this.arcMat) this.arcMat.emissiveIntensity = this.glow;
  }

  dispose(): void {
    // Geometrías compartidas: se liberan una vez desde el primer ojo.
    const first = this.eyes[0];
    if (first) {
      first.round.geometry.dispose();
      first.arc.geometry.dispose();
    }
    this.roundMat?.dispose();
    this.arcMat?.dispose();
    for (const { round, arc } of this.eyes) {
      round.removeFromParent();
      arc.removeFromParent();
    }
    this.eyes = [];
  }
}
