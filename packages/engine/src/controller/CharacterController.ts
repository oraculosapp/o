import * as THREE from "three";
import type { Planet } from "../planet/Planet";
import type { IAvatarRig } from "../avatar/types";
import { makeToonRamp, makeSoftCircleTexture, addInvertedHullOutline } from "../util/toon";

/** Intención de movimiento de un frame (la produce el InputManager). */
export interface MoveIntent {
  /** Dirección deseada en el plano tangente, en espacio mundo. Magnitud 0..1. */
  worldDir: THREE.Vector3;
  /** 0..1 cuánto acelerador (analógico en joystick, 1 en teclado). */
  throttle: number;
  run: boolean;
  jump: boolean;
}

const TMP = {
  up: new THREE.Vector3(),
  desired: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  move: new THREE.Vector3(),
  next: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  m: new THREE.Matrix4(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
};

/**
 * Character controller esférico: camina por toda la esfera con gravedad radial.
 * Aceleración/desaceleración suaves, rotación por slerp, salto con coyote-time
 * y jump-buffer, y colisión con el suelo vía raycast al hitmesh BVH.
 */
export class CharacterController {
  readonly object = new THREE.Group(); // pivote: +Y = up local, -Z = frente
  readonly position = new THREE.Vector3(0, 0, 0);

  // --- game feel (números afinados para que caminar sea delicioso) ---
  private readonly walkSpeed = 4;
  private readonly runSpeed = 7;
  private readonly accel = 34; // u/s²: arranque nítido pero no on/off
  private readonly decel = 26; // u/s²: frenada con algo de derrape
  private readonly gravity = 22; // u/s²
  private readonly jumpSpeed = 9.2; // → altura ~1.9 u
  private readonly coyoteTime = 0.12; // s de gracia tras dejar el suelo
  private readonly jumpBuffer = 0.12; // s de gracia si saltas antes de aterrizar
  private readonly turnRate = 12; // slerp/s hacia la dirección de avance
  private readonly slopeLimitCos = Math.cos(THREE.MathUtils.degToRad(50));
  /** Distancia pies→centro del pivote. Con rig = rig.height/2; sin rig, media cápsula. */
  private eyeHeight = 0.9;

  private horizVel = new THREE.Vector3(); // velocidad tangente (mundo)
  private vertVel = 0; // velocidad a lo largo de up (radial)
  private grounded = false;
  private timeSinceGround = 999;
  private timeSinceJumpReq = 999;
  private facing = new THREE.Quaternion();
  private groundNormal = new THREE.Vector3(0, 1, 0);

  private avatar?: THREE.Group;
  private blob!: THREE.Mesh;
  private rig?: IAvatarRig;

  constructor(
    private planet: Planet,
    spawnDir = new THREE.Vector3(0, 1, 0),
    rig?: IAvatarRig,
  ) {
    if (rig) {
      // Rig de avatar (TestDummy hoy, GLB Tripo3D mañana): su root tiene el
      // origen en los PIES; el pivote del controller está en el centro.
      this.rig = rig;
      this.eyeHeight = rig.height / 2;
      rig.root.position.set(0, -this.eyeHeight, 0);
      this.object.add(rig.root);
    } else {
      // Fallback: cápsula low-poly con nariz.
      this.buildAvatar();
    }
    this.buildBlobShadow();

    // Spawn: sobre el claro (+Y). Cae unos centímetros al suelo en el 1er frame.
    const p = this.planet.field.surfacePoint(spawnDir.clone().normalize());
    this.position.copy(p).addScaledVector(spawnDir.clone().normalize(), this.eyeHeight);
    this.object.position.copy(this.position);
    // Orientación inicial: up = normal, mirando "hacia el norte tangente".
    this.alignInitial(spawnDir.clone().normalize());
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.object);
    scene.add(this.blob);
  }

  get up(): THREE.Vector3 {
    return TMP.up.copy(this.position).normalize();
  }

  /** Frente actual del personaje en espacio mundo (tangente). */
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.facing);
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  update(dt: number, intent: MoveIntent): void {
    const up = this.position.clone().normalize();

    // --- 1. Velocidad horizontal objetivo desde la intención ---
    // Proyecta la dirección deseada al plano tangente (quita componente radial).
    TMP.desired.copy(intent.worldDir);
    TMP.desired.addScaledVector(up, -TMP.desired.dot(up));
    const hasInput = TMP.desired.lengthSq() > 1e-6 && intent.throttle > 0.02;
    if (hasInput) TMP.desired.normalize();

    const maxSpeed = (intent.run ? this.runSpeed : this.walkSpeed) * (hasInput ? intent.throttle : 0);
    TMP.desired.multiplyScalar(maxSpeed);

    // Reproyecta la velocidad actual al nuevo plano tangente (al rodar la esfera).
    this.horizVel.addScaledVector(up, -this.horizVel.dot(up));

    // Acelera o desacelera hacia la velocidad objetivo.
    const rate = hasInput ? this.accel : this.decel;
    TMP.move.copy(TMP.desired).sub(this.horizVel);
    const step = rate * dt;
    if (TMP.move.length() <= step) this.horizVel.copy(TMP.desired);
    else this.horizVel.addScaledVector(TMP.move.normalize(), step);

    // --- 2. Gravedad radial + salto (coyote-time + jump-buffer) ---
    this.timeSinceGround += dt;
    this.timeSinceJumpReq += dt;
    if (intent.jump) this.timeSinceJumpReq = 0;

    const canCoyote = this.timeSinceGround <= this.coyoteTime;
    const wantsJump = this.timeSinceJumpReq <= this.jumpBuffer;
    if (wantsJump && (this.grounded || canCoyote)) {
      this.vertVel = this.jumpSpeed;
      this.grounded = false;
      this.timeSinceGround = 999;
      this.timeSinceJumpReq = 999;
    }
    this.vertVel -= this.gravity * dt;

    // --- 3. Integración ---
    TMP.next.copy(this.position);
    TMP.next.addScaledVector(this.horizVel, dt);
    TMP.next.addScaledVector(up, this.vertVel * dt);

    // --- 4. Colisión con el suelo (raycast al hitmesh BVH) ---
    const nextUp = TMP.next.clone().normalize();
    const hit = this.planet.sampleGround(TMP.next, nextUp, 14);
    if (hit) {
      const groundY = hit.point.clone().sub(TMP.next).dot(nextUp); // <0 si suelo debajo
      const feetTarget = this.eyeHeight; // centro debe quedar a eyeHeight del suelo
      const centerAboveGround = -groundY; // altura del centro sobre el suelo

      // Pendiente no caminable: si es demasiado empinada, frena el avance.
      const walkable = hit.normal.dot(nextUp) >= this.slopeLimitCos;
      if (!walkable && this.grounded) {
        this.horizVel.multiplyScalar(0.2);
      }
      this.groundNormal.copy(hit.normal);

      if (this.vertVel <= 0 && centerAboveGround <= feetTarget + 0.35) {
        // Pegar al suelo.
        TMP.next.copy(hit.point).addScaledVector(nextUp, feetTarget);
        this.vertVel = 0;
        this.grounded = true;
        this.timeSinceGround = 0;
      } else {
        this.grounded = false;
      }
    } else {
      this.grounded = false;
    }

    this.position.copy(TMP.next);
    this.object.position.copy(this.position);

    // --- 5. Orientación: up = normal del planeta, frente = dirección de avance ---
    const orientUp = this.position.clone().normalize();
    if (this.horizVel.lengthSq() > 0.04) {
      TMP.fwd.copy(this.horizVel).addScaledVector(orientUp, -this.horizVel.dot(orientUp)).normalize();
    } else {
      this.getForward(TMP.fwd);
      TMP.fwd.addScaledVector(orientUp, -TMP.fwd.dot(orientUp)).normalize();
    }
    TMP.right.crossVectors(orientUp, TMP.fwd).normalize();
    // Recalcula frente ortonormal (evita drift): fwd = up x right... mantén fwd.
    TMP.m.makeBasis(TMP.right, orientUp, TMP.fwd.clone().negate());
    TMP.q.setFromRotationMatrix(TMP.m);
    // Slerp suave hacia la orientación objetivo.
    const tSlerp = 1 - Math.exp(-this.turnRate * dt);
    this.facing.slerp(TMP.q, tSlerp);
    this.object.quaternion.copy(this.facing);

    // --- 6. Conducción del rig de avatar (mixer + selección de clip) ---
    this.rig?.update(dt, {
      speed: this.horizVel.length(),
      maxSpeed: this.runSpeed,
      grounded: this.grounded,
      jumping: !this.grounded,
    });

    this.updateBlob(orientUp);
  }

  // ---- construcción del avatar placeholder ----

  private buildAvatar(): void {
    this.avatar = new THREE.Group();
    const ramp = makeToonRamp();
    const body = new THREE.MeshToonMaterial({ color: 0x8fa98c, gradientMap: ramp });
    const noseMat = new THREE.MeshToonMaterial({
      color: 0x3a2f18,
      emissive: new THREE.Color(0xe3b063),
      emissiveIntensity: 0.9,
      gradientMap: ramp,
    });

    // Cápsula (cuerpo). Altura total ~1.8, centro en el pivote.
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.95, 6, 12), body);
    addInvertedHullOutline(capsule, 0x0e1512, 1.06);
    this.avatar.add(capsule);

    // "Nariz" (cono) apuntando al frente (-Z) para leer la orientación.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 10), noseMat);
    nose.rotation.x = -Math.PI / 2; // punta hacia -Z
    nose.position.set(0, 0.25, -0.5);
    addInvertedHullOutline(nose, 0x0e1512, 1.1);
    this.avatar.add(nose);

    this.object.add(this.avatar);
  }

  private buildBlobShadow(): void {
    const tex = makeSoftCircleTexture("rgba(10,14,10,0.55)");
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      color: 0x0a0e0a,
      fog: true,
    });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), mat);
    this.blob.renderOrder = 1;
  }

  private updateBlob(up: THREE.Vector3): void {
    // Proyecta el blob al suelo bajo el personaje, orientado a la normal.
    const hit = this.planet.sampleGround(this.position, up, 14);
    const surface = hit ? hit.point : this.position.clone().addScaledVector(up, -this.eyeHeight);
    const nrm = hit ? hit.normal : up;
    this.blob.position.copy(surface).addScaledVector(nrm, 0.05);
    this.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
    // El blob se encoge un poco al saltar (aire = sombra más chica y tenue).
    const airborne = THREE.MathUtils.clamp(1 - Math.abs(this.vertVel) * 0.05, 0.5, 1);
    this.blob.scale.setScalar(airborne);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.5 * airborne;
  }

  /** Orienta el personaje para mirar hacia un punto de mundo (frente tangente). */
  faceToward(worldPoint: THREE.Vector3): void {
    const up = this.position.clone().normalize();
    const fwd = worldPoint.clone().sub(this.position);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-5) return;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
    this.facing.setFromRotationMatrix(m);
    this.object.quaternion.copy(this.facing);
  }

  private alignInitial(up: THREE.Vector3): void {
    // Frente inicial tangente arbitrario (proyecta -Z global al plano tangente).
    const fwd = new THREE.Vector3(0, 0, -1);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0).addScaledVector(up, -up.x);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
    this.facing.setFromRotationMatrix(m);
    this.object.quaternion.copy(this.facing);
  }

  dispose(): void {
    // El rig es propiedad de quien lo inyectó (PaqoWorld llama rig.dispose());
    // se desengancha aquí para no liberar sus recursos dos veces.
    if (this.rig) this.object.remove(this.rig.root);
    this.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
  }
}
