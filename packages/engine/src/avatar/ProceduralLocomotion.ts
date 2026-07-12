import * as THREE from "three";
import type { AvatarDriveState } from "./types";

/**
 * ProceduralLocomotion — animador de locomoción PROCEDURAL para esqueletos
 * humanoides Mixamo, sin depender de clips de animación.
 *
 * Motivo: el primer avatar real (hacker-girl.glb) trae rig Mixamo completo pero
 * SÓLO poses estáticas (clips de duración 0). Este animador le da alma —
 * caminar/correr/idle/salto— generando cuaterniones por hueso a partir de un
 * reloj de FASE atado a la DISTANCIA recorrida (no al tiempo → cero patinaje).
 *
 * ── Estrategia de ejes (lo que lo hace robusto) ────────────────────────────
 * Los rigs Mixamo, al pasar por FBX/glTF, quedan con orientaciones de hueso
 * arbitrarias (aquí el `_rootJoint` viene rotado −90° X: el "arriba" de la cadera
 * es su +Z local). En lugar de asumir "las piernas giran en su X local", medimos
 * la orientación de CADA hueso en su pose de reposo (`getWorldQuaternion`) y
 * convertimos los ejes de MUNDO (sagital = X, vertical = Y, lateral = Z) al
 * espacio LOCAL del hueso:
 *
 *     ejeLocal = inverse(quatMundoHueso) · ejeMundo
 *
 * Rotar el hueso `restQuat · quat(ejeLocal, θ)` equivale EXACTAMENTE a una
 * prerrotación de mundo `quat(ejeMundo, θ) · quatMundoHueso` (conjugación de
 * cuaterniones). Así el balanceo de pierna cae siempre en el plano sagital sea
 * cual sea la convención del export. Left/right comparten eje y signo: la
 * antifase se logra desfasando θ media vuelta, no invirtiendo el eje.
 *
 * ── Pose base ──────────────────────────────────────────────────────────────
 * Aditivo sobre la POSE DE REPOSO del nodo (la que el GLB trae por defecto:
 * brazos abajo, natural), capturada una vez por hueso. El mixer de clips NO
 * conduce estos huesos cuando el procedural está activo (los clips-pose quedan
 * como decorado disponible), así la pose base persiste como cimiento.
 *
 * CPU: ~15 huesos mapeados, sólo un cuaternión + (cadera) una traslación por
 * hueso y frame. Sin allocations en el bucle (buffers reutilizados).
 */

/** Nombres canónicos de los huesos que el animador sabe conducir. */
type BoneKey =
  | "hips"
  | "spine"
  | "spine1"
  | "spine2"
  | "neck"
  | "head"
  | "leftShoulder"
  | "leftArm"
  | "leftForeArm"
  | "rightShoulder"
  | "rightArm"
  | "rightForeArm"
  | "leftUpLeg"
  | "leftLeg"
  | "leftFoot"
  | "leftToeBase"
  | "rightUpLeg"
  | "rightLeg"
  | "rightFoot"
  | "rightToeBase";

/** Datos precomputados por hueso mapeado (pose de reposo + ejes locales). */
interface BoneNode {
  bone: THREE.Bone;
  restQuat: THREE.Quaternion;
  restPos: THREE.Vector3;
  /** Eje LOCAL cuya rotación produce giro sagital (mundo X): balanceo adelante/atrás. */
  sagittal: THREE.Vector3;
  /** Eje LOCAL cuya rotación produce giro vertical (mundo Y): twist de torso. */
  vertical: THREE.Vector3;
  /** Eje LOCAL cuya rotación produce giro lateral (mundo Z): inclinación de peso. */
  lateral: THREE.Vector3;
}

/** Ejes de mundo de referencia. */
const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

/**
 * Signo de "adelante". Una rotación +θ sobre mundo X lleva el pie (que cuelga en
 * −Y) hacia −Z. El avatar de Phygitalia mira a −Z en el frame del controller, así
 * que FORWARD=+1 inclina/empuja en la dirección de avance. Ajustado tras la
 * validación en navegador.
 */
const FORWARD = 1;

/**
 * Parámetros del ciclo. Amplitudes en radianes salvo indicación. Los valores
 * "run" se interpolan desde "walk" con la velocidad normalizada. Contemplativo,
 * no militar: senoidal suave, amplitudes moderadas, ruido sutil.
 */
const P = {
  /** Distancia de mundo (u) por CICLO de marcha completo (2 pasos). Fija la cadencia. */
  strideWalk: 2.1,
  strideRun: 3.0,

  /** Balanceo de muslo (UpLeg) — pico de oscilación. */
  hipSwingWalk: 0.42,
  hipSwingRun: 0.72,
  /** Flexión de rodilla (Leg) en la fase de vuelo. */
  kneeFlexWalk: 0.55,
  kneeFlexRun: 1.05,
  /** Flexión de tobillo (Foot) para amortiguar el contacto. */
  ankleWalk: 0.18,
  ankleRun: 0.3,

  /** Balanceo de brazo (Arm), en contrafase con la pierna del mismo lado. */
  armSwingWalk: 0.32,
  armSwingRun: 0.62,
  /** Flexión de antebrazo (ForeArm), mayor al correr (brazos más recogidos). */
  foreArmWalk: 0.22,
  foreArmRun: 0.6,

  /** Bob vertical de cadera como fracción de la altura (2 subidas por ciclo). */
  bobFrac: 0.03,
  /** Vaivén lateral de cadera (u de mundo) y balanceo de peso (rad). */
  hipSwayWalk: 0.02,
  hipRollWalk: 0.05,

  /** Twist de columna (contrarrotación de hombros vs cadera), rad. */
  spineTwistWalk: 0.09,
  spineTwistRun: 0.16,
  /** Inclinación adelante del torso proporcional a la velocidad, rad. */
  leanWalk: 0.06,
  leanRun: 0.22,
  /** Inclinación extra proporcional a la aceleración, rad·s/u. */
  leanPerAccel: 0.012,

  /** Idle: respiración (pitch de columna) y su frecuencia (Hz). */
  breatheAmp: 0.025,
  breatheHz: 0.22,
  /** Idle: micro-vaivén de peso, intervalo aleatorio (s) y amplitud (rad). */
  swayMin: 4,
  swayMax: 7,
  swayAmp: 0.05,

  /** Salto/aire: flexión de pierna y brazos arriba-atrás. */
  airHip: 0.5,
  airKnee: 0.8,
  airArm: 1.7,
  /** Squash de aterrizaje (fracción de altura, cadera baja) y su decaimiento (s). */
  landSquash: 0.08,
  landDecay: 0.28,

  /** Constante de damping del blend (s): cuánto tarda una amplitud en seguir su objetivo. */
  blendTau: 0.14,
  /** Ruido orgánico: fracción de variación de amplitud (±). */
  noiseFrac: 0.05,
} as const;

/** Normaliza un nombre de hueso Mixamo: sin "mixamorig:", sin sufijo "_NN", minúsculas. */
function normalizeBoneName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^mixamorig[:_]?/, "")
    .replace(/[_\s]?end$/, "")
    .replace(/_\d+$/, "")
    .replace(/[:_\s]/g, "");
}

/** Tabla nombre-normalizado → clave canónica. */
const NAME_TO_KEY: Record<string, BoneKey> = {
  hips: "hips",
  spine: "spine",
  spine1: "spine1",
  spine2: "spine2",
  neck: "neck",
  head: "head",
  leftshoulder: "leftShoulder",
  leftarm: "leftArm",
  leftforearm: "leftForeArm",
  rightshoulder: "rightShoulder",
  rightarm: "rightArm",
  rightforearm: "rightForeArm",
  leftupleg: "leftUpLeg",
  leftleg: "leftLeg",
  leftfoot: "leftFoot",
  lefttoebase: "leftToeBase",
  rightupleg: "rightUpLeg",
  rightleg: "rightLeg",
  rightfoot: "rightFoot",
  righttoebase: "rightToeBase",
};

/** Métricas de QA que expone el animador (para /dev/avatar y el smoke de __PAQO__). */
export interface LocomotionQA {
  /** ¿El animador está activo (mapeó los huesos clave)? */
  active: boolean;
  /** Estado de marcha actual. */
  gait: "idle" | "walk" | "run" | "air";
  /** Velocidad normalizada 0..1 amortiguada (peso de locomoción). */
  speedN: number;
  /** Fase del ciclo 0..2π (avanza con la DISTANCIA, no el tiempo). */
  phase: number;
  /** Distancia total recorrida (u de mundo) integrada por el animador. */
  distance: number;
  /** Ángulo sagital actual del muslo izquierdo/derecho (rad) — deben ir en antifase. */
  legPhaseL: number;
  legPhaseR: number;
  /**
   * Cadencia instantánea: ciclos de marcha por unidad de distancia (1/strideLength).
   * Constante ⇒ la fase es proporcional a la distancia ⇒ sin patinaje.
   */
  cyclesPerUnit: number;
  /** Nombres canónicos de los huesos que se mapearon. */
  mappedBones: string[];
}

export class ProceduralLocomotion {
  /** ¿Se mapearon los huesos mínimos (cadera + 2 piernas)? Si no, no anima. */
  readonly applied: boolean;
  /** Diagnóstico de por qué no aplicó (huesos faltantes), o "" si aplicó. */
  readonly reason: string;

  private nodes = new Map<BoneKey, BoneNode>();

  // Reloj de fase atado a la distancia.
  private phase = 0;
  private distance = 0;

  // Amplitudes/estados amortiguados (blend suave).
  private speedN = 0; // velocidad normalizada 0..1
  private airW = 0; // peso de la pose de aire 0..1
  private landT = 0; // temporizador de squash de aterrizaje
  private prevSpeed = 0;
  private accel = 0;

  // Idle: reloj interno (acumulado por dt, no wall-clock) + micro-vaivén.
  private idleTime = 0;
  private swayTimer = 0;
  private swayNext = 5;
  private swayPhase = 0;

  // Semilla de ruido por-lado para el jitter orgánico.
  private noiseSeed = Math.random() * 1000;

  // Buffers reutilizables (cero allocations por frame).
  private _q = new THREE.Quaternion();
  private _q2 = new THREE.Quaternion();
  private _v = new THREE.Vector3();

  private constructor(root: THREE.Object3D) {
    // Asegura matrices de mundo al día antes de medir orientaciones de reposo.
    root.updateMatrixWorld(true);

    const bones: THREE.Bone[] = [];
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });

    const worldQ = new THREE.Quaternion();
    const invQ = new THREE.Quaternion();
    for (const bone of bones) {
      const key = NAME_TO_KEY[normalizeBoneName(bone.name)];
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

    // Cadera para el bob vertical: necesito el eje (en el frame del PADRE de la
    // cadera) que apunta hacia el "arriba" de mundo, para trasladar sin depender
    // de la rotación del root.
    const hips = this.nodes.get("hips");
    if (hips && hips.bone.parent) {
      (hips.bone.parent as THREE.Object3D).getWorldQuaternion(worldQ);
      invQ.copy(worldQ).invert();
      this.hipsUpAxis = WORLD_Y.clone().applyQuaternion(invQ).normalize();
      this.hipsSideAxis = WORLD_X.clone().applyQuaternion(invQ).normalize();
    }

    const missing: BoneKey[] = [];
    for (const req of ["hips", "leftUpLeg", "rightUpLeg", "leftLeg", "rightLeg"] as BoneKey[]) {
      if (!this.nodes.has(req)) missing.push(req);
    }
    this.applied = missing.length === 0;
    this.reason = this.applied ? "" : `faltan huesos clave: ${missing.join(", ")}`;
    this.height = this.applied ? this.measureHeight(root) : 1.7;
  }

  private hipsUpAxis = new THREE.Vector3(0, 1, 0);
  private hipsSideAxis = new THREE.Vector3(1, 0, 0);
  private height = 1.7;

  private measureHeight(root: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    return size.y || 1.7;
  }

  /**
   * Intenta crear el animador para `root`. Devuelve `null` si el esqueleto NO
   * mapea como humanoide Mixamo (faltan cadera + 2 piernas). El llamador
   * (AvatarRig) cae entonces al AnimationDriver de clips.
   */
  static tryCreate(root: THREE.Object3D): ProceduralLocomotion | null {
    const loco = new ProceduralLocomotion(root);
    return loco.applied ? loco : null;
  }

  // ---- bucle ----

  update(dt: number, state: AvatarDriveState): void {
    if (!this.applied) return;
    if (dt <= 0) return;

    // 1. Velocidad normalizada + aceleración (para el lean dinámico).
    this.idleTime += dt;
    const rawN = state.maxSpeed > 0 ? THREE.MathUtils.clamp(state.speed / state.maxSpeed, 0, 1) : 0;
    const k = 1 - Math.exp(-dt / P.blendTau);
    this.speedN += (rawN - this.speedN) * k;
    const instAccel = (state.speed - this.prevSpeed) / dt;
    this.accel += (instAccel - this.accel) * (1 - Math.exp(-dt / 0.18));
    this.prevSpeed = state.speed;

    // 2. Peso de la pose de aire (blend rápido al saltar/caer).
    const airTarget = state.jumping || !state.grounded ? 1 : 0;
    const airK = 1 - Math.exp(-dt / (airTarget > this.airW ? 0.08 : 0.14));
    const wasAir = this.airW > 0.5;
    this.airW += (airTarget - this.airW) * airK;
    if (wasAir && this.airW <= 0.5 && state.grounded) this.landT = P.landDecay; // aterrizó → squash

    // 3. Fase por distancia (cero patinaje): avanza con la velocidad real.
    const stride = THREE.MathUtils.lerp(P.strideWalk, P.strideRun, this.runBlend());
    const dDist = state.speed * dt;
    this.distance += dDist;
    if (state.grounded) this.phase += (dDist / stride) * Math.PI * 2;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2 * Math.floor(this.phase / (Math.PI * 2));

    // 4. Reset a reposo de los huesos mapeados (base de la suma).
    for (const n of this.nodes.values()) {
      n.bone.quaternion.copy(n.restQuat);
      if (n.bone === this.nodes.get("hips")?.bone) n.bone.position.copy(n.restPos);
    }

    // 5. Compón las capas.
    const groundW = 1 - this.airW;
    if (groundW > 0.001) {
      if (this.speedN > 0.06) this.applyGait(groundW);
      else this.applyIdle(dt, groundW);
    }
    if (this.airW > 0.001) this.applyAir(this.airW);
    if (this.landT > 0) {
      this.landT = Math.max(0, this.landT - dt);
      this.applyLandSquash(this.landT / P.landDecay);
    }
  }

  /** Peso de "correr" 0..1 dentro del rango de locomoción (walk empieza ~0.12). */
  private runBlend(): number {
    return THREE.MathUtils.clamp((this.speedN - 0.45) / 0.55, 0, 1);
  }

  /** Peso de "caminar" 0..1 (arranca la locomoción desde idle). */
  private walkBlend(): number {
    return THREE.MathUtils.smoothstep(this.speedN, 0.06, 0.32);
  }

  // ---- capas ----

  private applyGait(w: number): void {
    const run = this.runBlend();
    const walkW = this.walkBlend();
    const amp = walkW * w; // el balanceo entra suave desde idle
    const p = this.phase;

    const hipSwing = THREE.MathUtils.lerp(P.hipSwingWalk, P.hipSwingRun, run) * amp;
    const kneeFlex = THREE.MathUtils.lerp(P.kneeFlexWalk, P.kneeFlexRun, run) * amp;
    const ankle = THREE.MathUtils.lerp(P.ankleWalk, P.ankleRun, run) * amp;
    const armSwing = THREE.MathUtils.lerp(P.armSwingWalk, P.armSwingRun, run) * amp;
    const foreArm = THREE.MathUtils.lerp(P.foreArmWalk, P.foreArmRun, run);
    const twist = THREE.MathUtils.lerp(P.spineTwistWalk, P.spineTwistRun, run) * amp;

    // Piernas en antifase. Left lidera con la fase p, right con p+π.
    this.legChain("leftUpLeg", "leftLeg", "leftFoot", "leftToeBase", p, hipSwing, kneeFlex, ankle, 1);
    this.legChain("rightUpLeg", "rightLeg", "rightFoot", "rightToeBase", p + Math.PI, hipSwing, kneeFlex, ankle, -1);

    // Brazos en CONTRAFASE con la pierna del mismo lado (marcha contralateral):
    // brazo izq acompaña a pierna der → fase p (misma que rightUpLeg = p+π ⇒ brazo izq = p+π? )
    // Contralateral: brazo_izq ~ pierna_der (p+π). Lo desfasamos otra media vuelta
    // respecto a su propia pierna para el swing natural.
    this.armChain("leftArm", "leftForeArm", p + Math.PI, armSwing, foreArm, 1);
    this.armChain("rightArm", "rightForeArm", p, armSwing, foreArm, -1);

    // Twist de columna (hombros contrarrotan la cadera) + bob + sway + lean.
    this.spineTwist(twist, p);
    this.hipBobAndSway(amp, p);
    this.applyLean(walkW * w);
    this.stabilizeHead(twist * 0.5, p);
  }

  /** Cadena de una pierna: muslo (swing), rodilla (flexión en vuelo), tobillo. */
  private legChain(
    up: BoneKey,
    leg: BoneKey,
    foot: BoneKey,
    toe: BoneKey,
    ph: number,
    hipSwing: number,
    kneeFlex: number,
    ankle: number,
    side: 1 | -1,
  ): void {
    const swing = Math.sin(ph) * hipSwing * this.noise(ph, side);
    this.rotateBone(up, "sagittal", swing);

    // Rodilla: se dobla en la fase de VUELO (pierna que va hacia adelante y se
    // recoge). Pico tras cruzar la vertical; siempre flexión (un solo sentido).
    const flight = Math.max(0, Math.sin(ph + Math.PI * 0.5));
    const knee = -(flight * flight) * kneeFlex;
    this.rotateBone(leg, "sagittal", knee);

    // Tobillo: contrarresta un poco el muslo para que el pie caiga más plano.
    this.rotateBone(foot, "sagittal", -swing * 0.35 + ankle * Math.sin(ph + 0.6));
    // Dedos: leve despegue al final del apoyo.
    this.rotateBone(toe, "sagittal", Math.max(0, -Math.sin(ph)) * ankle * 0.6);
  }

  /** Cadena de un brazo: hombro/brazo (swing sagital) + antebrazo (flexión). */
  private armChain(arm: BoneKey, foreArm: BoneKey, ph: number, swing: number, foreAmp: number, side: 1 | -1): void {
    const s = Math.sin(ph) * swing * this.noise(ph + 10, side);
    this.rotateBone(arm, "sagittal", s);
    // El antebrazo se recoge cuando el brazo va hacia adelante.
    const bend = (0.5 + 0.5 * Math.sin(ph)) * foreAmp * this.walkBlend();
    this.rotateBone(foreArm, "sagittal", -bend);
  }

  /** Contrarrotación de columna: los hombros giran opuesto a la pelvis. */
  private spineTwist(amp: number, p: number): void {
    const t = Math.sin(p) * amp;
    // La pelvis (hips) gira un poco con las piernas; la columna al revés.
    this.rotateBone("hips", "vertical", t * 0.4);
    this.rotateBone("spine", "vertical", -t * 0.6);
    this.rotateBone("spine1", "vertical", -t * 0.4);
    this.rotateBone("spine2", "vertical", -t * 0.3);
  }

  /** Bob vertical (2×/ciclo) + vaivén y balanceo lateral de peso. */
  private hipBobAndSway(amp: number, p: number): void {
    const hips = this.nodes.get("hips");
    if (!hips) return;
    // Bob: cadera más alta a media zancada de cada pie → coseno a doble frecuencia.
    const bob = -Math.cos(2 * p) * P.bobFrac * this.height * amp;
    // Vaivén lateral: la cadera se desplaza hacia el pie de apoyo.
    const sway = Math.sin(p) * P.hipSwayWalk * amp;
    this._v.copy(hips.restPos)
      .addScaledVector(this.hipsUpAxis, bob)
      .addScaledVector(this.hipsSideAxis, sway);
    hips.bone.position.copy(this._v);
    // Balanceo (roll) de la pelvis hacia el lado que carga peso.
    this.rotateBone("hips", "lateral", Math.sin(p) * P.hipRollWalk * amp);
  }

  /** Inclinación del torso adelante (velocidad + aceleración). */
  private applyLean(w: number): void {
    const run = this.runBlend();
    const lean =
      (THREE.MathUtils.lerp(P.leanWalk, P.leanRun, run) + this.accel * P.leanPerAccel) * w;
    const l = THREE.MathUtils.clamp(lean, -0.05, 0.4);
    // Se reparte por la columna para una curva natural (no una bisagra).
    this.rotateBone("spine", "sagittal", l * 0.5 * FORWARD);
    this.rotateBone("spine1", "sagittal", l * 0.3 * FORWARD);
    this.rotateBone("spine2", "sagittal", l * 0.2 * FORWARD);
  }

  /** Cabeza estabilizada: contrarresta parte del twist y del lean. */
  private stabilizeHead(counterTwist: number, p: number): void {
    this.rotateBone("neck", "vertical", Math.sin(p) * counterTwist);
    this.rotateBone("head", "vertical", Math.sin(p) * counterTwist * 0.6);
  }

  private applyIdle(dt: number, w: number): void {
    // Respiración: pitch suave de la columna, dos capas incommensurables. Usa el
    // reloj interno (acumulado por dt) → estable ante RAF pausado / dt irregular.
    const t = this.idleTime;
    const breathe = (Math.sin(t * P.breatheHz * Math.PI * 2) * 0.7 + Math.sin(t * P.breatheHz * 3.1) * 0.3);
    const b = breathe * P.breatheAmp * w;
    this.rotateBone("spine", "sagittal", b * 0.5 * FORWARD);
    this.rotateBone("spine1", "sagittal", b * 0.3 * FORWARD);
    this.rotateBone("head", "sagittal", -b * 0.4 * FORWARD);

    // Micro-vaivén de peso cada 4-7 s: desplaza el peso a un lado y vuelve.
    this.swayTimer += dt;
    if (this.swayTimer >= this.swayNext) {
      this.swayTimer = 0;
      this.swayNext = THREE.MathUtils.lerp(P.swayMin, P.swayMax, Math.random());
      this.swaySign = -this.swaySign;
    }
    // Envolvente suave (sube y baja) durante ~2.5 s tras el disparo.
    const env = Math.max(0, 1 - this.swayTimer / 2.5);
    this.swayPhase = this.swaySign * env * Math.sin((this.swayTimer / 2.5) * Math.PI);
    const s = this.swayPhase * P.swayAmp * w;
    this.rotateBone("hips", "lateral", s);
    this.rotateBone("spine", "lateral", -s * 0.4);
    this.rotateBone("head", "lateral", -s * 0.3);

    // Respiración también en brazos (levísimo).
    this.rotateBone("leftArm", "sagittal", b * 0.15);
    this.rotateBone("rightArm", "sagittal", b * 0.15);
  }
  private swaySign = 1;

  private applyAir(w: number): void {
    // Piernas semiflexionadas, brazos arriba-atrás. Aditivo con peso `w`.
    this.rotateBone("leftUpLeg", "sagittal", P.airHip * w);
    this.rotateBone("rightUpLeg", "sagittal", P.airHip * 0.7 * w);
    this.rotateBone("leftLeg", "sagittal", -P.airKnee * w);
    this.rotateBone("rightLeg", "sagittal", -P.airKnee * 0.7 * w);
    this.rotateBone("leftArm", "sagittal", -P.airArm * w);
    this.rotateBone("rightArm", "sagittal", -P.airArm * w);
    this.rotateBone("spine", "sagittal", 0.12 * w * FORWARD);
  }

  private applyLandSquash(t01: number): void {
    // t01: 1 al tocar, 0 al final. Cadera baja y rodillas ceden brevemente.
    const hips = this.nodes.get("hips");
    if (!hips) return;
    const env = Math.sin(t01 * Math.PI); // 0→pico→0
    this._v.copy(hips.bone.position).addScaledVector(this.hipsUpAxis, -P.landSquash * this.height * env);
    hips.bone.position.copy(this._v);
    this.rotateBone("leftLeg", "sagittal", -0.5 * env);
    this.rotateBone("rightLeg", "sagittal", -0.5 * env);
  }

  // ---- utilidades ----

  /** Rota un hueso mapeado sumando `restQuat · quat(ejeLocal, θ)`. No-op si falta. */
  private rotateBone(key: BoneKey, axis: "sagittal" | "vertical" | "lateral", angle: number): void {
    if (angle === 0) return;
    const n = this.nodes.get(key);
    if (!n) return;
    this._q2.setFromAxisAngle(n[axis], angle);
    n.bone.quaternion.multiply(this._q2);
  }

  /** Ruido orgánico multiplicativo (±P.noiseFrac) barato y determinista por fase/lado. */
  private noise(x: number, side: number): number {
    const s = Math.sin((x + this.noiseSeed + side * 3.7) * 1.3) * 0.5 + Math.sin((x + side) * 0.7) * 0.5;
    return 1 + s * P.noiseFrac;
  }

  getQA(): LocomotionQA {
    return {
      active: this.applied,
      gait: this.airW > 0.5 ? "air" : this.speedN < 0.06 ? "idle" : this.runBlend() > 0.5 ? "run" : "walk",
      speedN: this.speedN,
      phase: this.phase,
      distance: this.distance,
      legPhaseL: Math.sin(this.phase),
      legPhaseR: Math.sin(this.phase + Math.PI),
      cyclesPerUnit: 1 / THREE.MathUtils.lerp(P.strideWalk, P.strideRun, this.runBlend()),
      mappedBones: [...this.nodes.keys()],
    };
  }
}
