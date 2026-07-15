import * as THREE from "three";
import type { Island } from "../island/Island";
import type { IAvatarRig } from "../avatar/types";
import { makeToonRamp, makeSoftCircleTexture, addInvertedHullOutline } from "../util/toon";

/** Intención de movimiento de un frame (la produce el InputManager). */
export interface MoveIntent {
  /** Dirección deseada en el plano XZ, en espacio mundo. Magnitud 0..1. */
  worldDir: THREE.Vector3;
  /** 0..1 cuánto acelerador (analógico en joystick, 1 en teclado). */
  throttle: number;
  run: boolean;
  jump: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP = {
  desired: new THREE.Vector3(),
  move: new THREE.Vector3(),
  next: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  fwd: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  surf: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
};

/**
 * Character controller PLANAR de isla flotante: up constante (0,1,0), gravedad
 * -Y, anclaje al suelo ANALÍTICO (IslandField.heightAt, la misma fórmula que
 * desplaza la malla visual). Conserva TODO el game feel aprobado de la esfera
 * (aceleración 34/26, salto 9.2 con coyote 0.12, slide suave en pendientes,
 * turn por slerp). Añade caída al vacío: fuera del filo de la isla no hay suelo
 * y, pasado un umbral, el mundo hace respawn contemplativo en el claro.
 */
export class CharacterController {
  readonly object = new THREE.Group(); // pivote: +Y = up, -Z = frente
  readonly position = new THREE.Vector3(0, 0, 0);

  // --- game feel (idénticos a la esfera) ---
  private readonly walkSpeed = 4;
  private readonly runSpeed = 7;
  private readonly accel = 34;
  private readonly decel = 26;
  private readonly gravity = 22;
  private readonly jumpSpeed = 9.2;
  private readonly coyoteTime = 0.12;
  private readonly jumpBuffer = 0.12;
  // --- doble salto ---
  /** Máximo de saltos hasta tocar suelo (1 = suelo/coyote, 2 = aire). */
  private readonly maxJumps = 2;
  /** Impulso del segundo salto relativo al primero (un poco menor, eleva más). */
  private readonly doubleJumpFactor = 0.85;
  /** Saltos consumidos desde el último contacto con el suelo. */
  private jumpsUsed = 0;
  // 8/s (antes 12): giros más pausados — feedback del director en S3b.
  private readonly turnRate = 8;
  private readonly slopeLimitCos = Math.cos(THREE.MathUtils.degToRad(50));
  /** Margen (u) para posarse: pies a ≤ este valor por encima de la tapa. */
  private static readonly LAND_GRAB = 0.35;
  private eyeHeight = 0.9;

  private horizVel = new THREE.Vector3(); // velocidad en XZ (mundo)
  private vertVel = 0; // velocidad en Y
  private grounded = false;
  /** ¿El contacto actual es una copa pisable (tapa plana), no el terreno? */
  private onPlatform = false;
  private timeSinceGround = 999;
  private timeSinceJumpReq = 999;
  private facing = new THREE.Quaternion();
  private groundNormal = new THREE.Vector3(0, 1, 0);

  private spawn = new THREE.Vector3();
  /** Nivel Y por debajo del cual se considera "cayendo al vacío". */
  private readonly voidLevel: number;
  private falling = false;

  /** Se dispara una vez al cruzar al vacío (el mundo hace el fundido + respawn). */
  onVoidFall: (() => void) | null = null;

  /**
   * Proveedores de altura EXTRA (plataformas pisables como copas de árbol):
   * devuelven el top Y en (x,z) o null si ahí no hay plataforma.
   * [EQUIPO TIERRA] integra estos proveedores en la colisión de §4.
   */
  private heightProviders: Array<(x: number, z: number) => number | null> = [];

  /** Registra un proveedor de plataformas pisables. */
  addHeightProvider(p: (x: number, z: number) => number | null): void {
    this.heightProviders.push(p);
  }

  /**
   * Cota de la copa pisable MÁS ALTA bajo (x,z) cuya tapa esté ≤ pies+LAND_GRAB
   * (candidata a posarse — nunca una copa muy por encima que se agarraría desde
   * abajo), o null si ninguna. El descenso (vertVel≤0) se exige en quien llama.
   */
  private platformTopAt(x: number, z: number, feet: number): number | null {
    let best: number | null = null;
    for (let i = 0; i < this.heightProviders.length; i++) {
      const top = this.heightProviders[i](x, z);
      if (top === null) continue;
      if (top <= feet + CharacterController.LAND_GRAB && (best === null || top > best)) best = top;
    }
    return best;
  }

  private avatar?: THREE.Group;
  private blob!: THREE.Mesh;
  private rig?: IAvatarRig;

  constructor(
    private island: Island,
    spawnPos = new THREE.Vector3(0, 0, 7),
    rig?: IAvatarRig,
  ) {
    if (rig) {
      this.rig = rig;
      this.eyeHeight = rig.height / 2;
      rig.root.position.set(0, -this.eyeHeight, 0);
      this.object.add(rig.root);
    } else {
      this.buildAvatar();
    }
    this.buildBlobShadow();

    this.spawn.copy(spawnPos);
    this.voidLevel = island.field.clearLevel - 15;
    this.placeAtSpawn();
  }

  private placeAtSpawn(): void {
    const y = this.island.field.heightAt(this.spawn.x, this.spawn.z) + this.eyeHeight;
    this.position.set(this.spawn.x, y, this.spawn.z);
    this.object.position.copy(this.position);
    this.horizVel.set(0, 0, 0);
    this.vertVel = 0;
    this.grounded = true;
    this.onPlatform = false;
    this.jumpsUsed = 0;
    this.falling = false;
    this.alignInitial();
  }

  /** Reaparición suave en el claro (tras la caída al vacío). */
  respawn(): void {
    this.placeAtSpawn();
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.object);
    scene.add(this.blob);
  }

  /** Rig de avatar actual (dummy o arquetipo GLB), o undefined si usa la cápsula. */
  getRig(): IAvatarRig | undefined {
    return this.rig;
  }

  /**
   * Sustituye el rig de avatar en caliente (p.ej. cuando termina de cargar el GLB
   * del arquetipo elegido, tras arrancar con el maniquí). Conserva la posición de
   * los PIES: recalcula `eyeHeight` con la nueva altura y reancla el pivote para
   * que el avatar no “salte”. No rompe si venía de la cápsula placeholder.
   */
  setRig(rig: IAvatarRig): void {
    const feet = this.position.y - this.eyeHeight;

    if (this.rig) {
      this.object.remove(this.rig.root);
      this.rig.dispose();
    } else if (this.avatar) {
      this.object.remove(this.avatar);
      this.disposeSubtree(this.avatar);
      this.avatar = undefined;
    }

    this.rig = rig;
    this.eyeHeight = rig.height / 2;
    rig.root.position.set(0, -this.eyeHeight, 0);
    this.object.add(rig.root);

    this.position.y = feet + this.eyeHeight;
    this.object.position.copy(this.position);
  }

  private disposeSubtree(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  get up(): THREE.Vector3 {
    return UP;
  }

  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.facing);
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  /** ¿Puede encadenar un segundo salto ahora mismo? (en aire, con 1 salto usado). */
  canDoubleJump(): boolean {
    return !this.grounded && this.jumpsUsed >= 1 && this.jumpsUsed < this.maxJumps;
  }

  isFalling(): boolean {
    return this.falling;
  }

  /** Altura Y de los PIES (pivote − eyeHeight). Para contactos a ras de suelo. */
  get feetY(): number {
    return this.position.y - this.eyeHeight;
  }

  /** Velocidad horizontal actual (u/s, mundo). Copia en `out`; no mutar la interna. */
  getHorizVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.horizVel);
  }

  /**
   * Error de anclaje al suelo (u): (Y de los pies) − heightAt(x,z). Debe ser ~0
   * cuando el personaje está en pie sobre la isla. Para la métrica de QA.
   */
  groundError(): number {
    const feet = this.position.y - this.eyeHeight;
    // Superficie efectiva: terreno o copa pisable directamente bajo los pies
    // (así el error es ~0 tanto en el suelo como encaramado a un árbol).
    let surf = this.island.field.heightAt(this.position.x, this.position.z);
    const plat = this.platformTopAt(this.position.x, this.position.z, feet);
    if (plat !== null && plat > surf) surf = plat;
    return feet - surf;
  }

  update(dt: number, intent: MoveIntent): void {
    const field = this.island.field;

    // --- 1. Velocidad horizontal objetivo (XZ) ---
    TMP.desired.copy(intent.worldDir);
    TMP.desired.y = 0;
    const hasInput = TMP.desired.lengthSq() > 1e-6 && intent.throttle > 0.02;
    if (hasInput) TMP.desired.normalize();

    const maxSpeed =
      (intent.run ? this.runSpeed : this.walkSpeed) * (hasInput ? intent.throttle : 0);
    TMP.desired.multiplyScalar(maxSpeed);

    this.horizVel.y = 0;
    const rate = hasInput ? this.accel : this.decel;
    TMP.move.copy(TMP.desired).sub(this.horizVel);
    const step = rate * dt;
    if (TMP.move.length() <= step) this.horizVel.copy(TMP.desired);
    else this.horizVel.addScaledVector(TMP.move.normalize(), step);

    // --- 2. Gravedad -Y + salto (coyote-time + jump-buffer) ---
    this.timeSinceGround += dt;
    this.timeSinceJumpReq += dt;
    if (intent.jump) this.timeSinceJumpReq = 0;

    const canCoyote = this.timeSinceGround <= this.coyoteTime;
    const wantsJump = this.timeSinceJumpReq <= this.jumpBuffer;
    if (wantsJump && this.jumpsUsed === 0 && (this.grounded || canCoyote)) {
      // Primer salto: desde suelo o dentro del coyote-time (conserva jump-buffer).
      this.vertVel = this.jumpSpeed;
      this.grounded = false;
      this.jumpsUsed = 1;
      this.timeSinceGround = 999;
      this.timeSinceJumpReq = 999;
    } else if (
      intent.jump &&
      !this.grounded &&
      this.jumpsUsed >= 1 &&
      this.jumpsUsed < this.maxJumps
    ) {
      // Doble salto: NUEVA pulsación de Space en el aire (edge crudo, no el
      // buffer, para exigir una segunda pulsación real). Impulso 0.85× reiniciado
      // desde la velocidad actual → desde el ápex eleva por encima de un salto
      // simple. Máximo 2 saltos hasta volver a tocar suelo.
      this.vertVel = this.jumpSpeed * this.doubleJumpFactor;
      this.jumpsUsed += 1;
      this.timeSinceJumpReq = 999;
    }
    this.vertVel -= this.gravity * dt;

    // --- 2.5 Muro de pendiente (slide suave, ANTES de integrar) ---
    // Sobre una copa (tapa plana) no hay slide: se ignora la pendiente del terreno.
    if (this.grounded && !this.onPlatform) {
      const nrm = field.surfaceNormal(this.position.x, this.position.z, TMP.normal);
      if (nrm.y < this.slopeLimitCos) {
        // Parte horizontal de la normal apunta cuesta ABAJO → uphill = su opuesto.
        TMP.tangent.set(nrm.x, 0, nrm.z);
        if (TMP.tangent.lengthSq() > 1e-8) {
          TMP.tangent.negate().normalize();
          const vUphill = this.horizVel.dot(TMP.tangent);
          if (vUphill > 0) this.horizVel.addScaledVector(TMP.tangent, -vUphill);
        }
      }
    }

    // --- 3. Integración ---
    TMP.next.copy(this.position);
    TMP.next.addScaledVector(this.horizVel, dt);
    TMP.next.y += this.vertVel * dt;

    // --- 4. Colisión: suelo analítico + copas pisables, o vacío fuera del filo ---
    const feet = TMP.next.y - this.eyeHeight;
    const onIsland = field.insideIsland(TMP.next.x, TMP.next.z);

    // Terreno bajo los pies (o -Infinity fuera de la isla).
    let surfaceY = -Infinity;
    if (onIsland) {
      surfaceY = field.heightAt(TMP.next.x, TMP.next.z);
      field.surfaceNormal(TMP.next.x, TMP.next.z, this.groundNormal);
    } else {
      // Fuera de la isla: no hay suelo (money shot de isla flotante).
      this.groundNormal.copy(UP);
    }

    // Copa pisable: SOLO al aterrizar CAYENDO (vertVel≤0); platformTopAt ya
    // descarta las copas por encima de los pies (no se teleporta al pasar por
    // debajo subiendo). Se queda con la más alta pisable.
    const platformY = this.vertVel <= 0 ? this.platformTopAt(TMP.next.x, TMP.next.z, feet) : null;

    // Superficie efectiva = la más alta entre terreno y copa pisable.
    const standingOnPlatform = platformY !== null && platformY >= surfaceY;
    const effSurface = standingOnPlatform ? (platformY as number) : surfaceY;

    if (effSurface > -Infinity && this.vertVel <= 0 && feet - effSurface <= 0.35) {
      TMP.next.y = effSurface + this.eyeHeight;
      this.vertVel = 0;
      this.grounded = true;
      this.timeSinceGround = 0;
      this.jumpsUsed = 0; // al aterrizar se recarga el doble salto
      this.onPlatform = standingOnPlatform;
      if (standingOnPlatform) this.groundNormal.copy(UP); // copa: tapa plana
    } else {
      this.grounded = false;
      this.onPlatform = false;
    }

    this.position.copy(TMP.next);
    this.object.position.copy(this.position);

    // --- 4.5 Caída al vacío → aviso al mundo (fundido + respawn) ---
    if (!this.falling && this.position.y < this.voidLevel) {
      this.falling = true;
      this.onVoidFall?.();
    }

    // --- 5. Orientación: up = +Y, frente = dirección de avance ---
    // Estilo Messenger: mientras camina, slerp suave hacia SU dirección de
    // movimiento; en reposo conserva la orientación (no sigue a la cámara).
    // El yaw se calcula DIRECTO alrededor de +Y desde la velocidad horizontal.
    // (El makeBasis heredado de la esfera construía right = up×fwd — que es el
    // vector IZQUIERDO → matriz reflejo (det -1); con up = +Y exacto su
    // quaternion degeneraba a identidad para cualquier rumbo y el avatar nunca
    // giraba. En la esfera el up variable enmascaraba el defecto.)
    if (this.horizVel.lengthSq() > 0.04) {
      // El frente local es -Z: R_y(yaw)·(0,0,-1) = (-sin yaw, 0, -cos yaw).
      const yaw = Math.atan2(-this.horizVel.x, -this.horizVel.z);
      TMP.q.setFromAxisAngle(UP, yaw);
      const tSlerp = 1 - Math.exp(-this.turnRate * dt);
      this.facing.slerp(TMP.q, tSlerp);
    }
    this.object.quaternion.copy(this.facing);

    // --- 6. Conducción del rig de avatar ---
    this.rig?.update(dt, {
      speed: this.horizVel.length(),
      maxSpeed: this.runSpeed,
      grounded: this.grounded,
      jumping: !this.grounded,
    });

    this.updateBlob();
  }

  // ---- avatar placeholder ----

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
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.95, 6, 12), body);
    addInvertedHullOutline(capsule, 0x0e1512, 1.06);
    this.avatar.add(capsule);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 10), noseMat);
    nose.rotation.x = -Math.PI / 2;
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

  private updateBlob(): void {
    const field = this.island.field;
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    const feet = this.position.y - this.eyeHeight;
    const onIsland = field.insideIsland(this.position.x, this.position.z);
    // Copa pisable directamente bajo los pies: la sombra se posa en su tapa plana.
    const plat = this.platformTopAt(this.position.x, this.position.z, feet);
    if (!onIsland && plat === null) {
      mat.opacity = 0; // en el aire sobre el vacío: sin sombra
      return;
    }
    const terrainY = onIsland ? field.heightAt(this.position.x, this.position.z) : -Infinity;
    if (plat !== null && plat > terrainY) {
      TMP.surf.set(this.position.x, plat, this.position.z);
      TMP.normal.copy(UP);
    } else {
      field.surfacePoint(this.position.x, this.position.z, TMP.surf);
      field.surfaceNormal(this.position.x, this.position.z, TMP.normal);
    }
    this.blob.position.copy(TMP.surf).addScaledVector(TMP.normal, 0.05);
    this.blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), TMP.normal);
    const airborne = THREE.MathUtils.clamp(1 - Math.abs(this.vertVel) * 0.05, 0.5, 1);
    this.blob.scale.setScalar(airborne);
    mat.opacity = 0.5 * airborne;
  }

  /** Orienta el personaje para mirar hacia un punto de mundo (frente en XZ). */
  faceToward(worldPoint: THREE.Vector3): void {
    TMP.fwd.copy(worldPoint).sub(this.position);
    TMP.fwd.y = 0;
    if (TMP.fwd.lengthSq() < 1e-5) return;
    // Frente local -Z → yaw = atan2(-fx, -fz) (mismo marco que update §5).
    this.facing.setFromAxisAngle(UP, Math.atan2(-TMP.fwd.x, -TMP.fwd.z));
    this.object.quaternion.copy(this.facing);
  }

  private alignInitial(): void {
    // Frente inicial -Z global = yaw 0 (identidad).
    this.facing.identity();
    this.object.quaternion.copy(this.facing);
  }

  dispose(): void {
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
