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
  /**
   * Dirección COMPLETA de la mirada de la cámara (con componente vertical), en
   * espacio mundo y normalizada. La rellena PaqoWorld con `camera.getWorldDirection`.
   * Sólo se usa en VUELO: "hacia donde miras es hacia donde vuelas" — el pitch de la
   * cámara inclina el vuelo hacia arriba/abajo. Opcional: sin ella el vuelo queda
   * planar (sin ganancia/pérdida de altura por mirada).
   */
  lookDir?: THREE.Vector3;
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
  flyTarget: new THREE.Vector3(),
};
/**
 * Frecuencia angular del bob de flotación idle en vuelo. 0.35 Hz (→ 2π·0.35): más
 * LENTO que la v1 (0.5 Hz) para un flote gentil y pausado — feedback de Julio
 * ("que suba y baje poco y con ease").
 */
const FLY_BOB_W = 2 * Math.PI * 0.35;
/**
 * Amplitud (u) del bob de flotación idle en vuelo. SUTIL: 0.07 (v1 era 0.15) —
 * "sube y baja poco". El desplazamiento pico ≈ FLY_BOB_AMP porque la curva de ease
 * cumple ease(±1)=±1 (ver `updateFly`).
 */
const FLY_BOB_AMP = 0.07;

/**
 * DESPEGUE (liftoff) — altura (u) que gana la fase automática de despegue sobre el
 * suelo desde el que se activó el vuelo (tecla Q / botón "Volar" estando en tierra).
 * REFERENCIA DE JULIO: el tótem de Paqo mide 8.5 u de alto (`world/Totem.ts`,
 * `targetHeight = 8.5`, posado en el claro). El despegue debe SENTIRSE vuelo pero
 * NO sobrepasar a Paqo: con 6 u de pies + ~1.8 u de avatar la cabeza queda ~7.8 u,
 * por debajo de los 8.5 u de Paqo.
 * NO es un techo de vuelo: pasada la fase, mirar arriba y avanzar sube sin límite.
 */
const LIFTOFF_RISE = 6;
/**
 * DESPEGUE — tope DURO (u) sobre el suelo de despegue: la fase nunca eleva más de
 * esto, pase lo que pase (p.ej. un pico de `dt`). Queda por debajo de los 8.5 u de
 * Paqo. Guarda de seguridad: con la curva normal manda `LIFTOFF_RISE` (6 u).
 */
const LIFTOFF_MAX_ABS = 8;
/**
 * DESPEGUE — velocidad vertical inicial (u/s). Un pelín por encima del salto (9.2)
 * para que el arranque se sienta un impulso de verdad ("que salte más alto de inicio").
 */
const LIFTOFF_SPEED = 10;
/**
 * DESPEGUE — desaceleración (u/s²) de la curva EASE-OUT: rápido al inicio, se demora
 * al llegar. Derivada de v₀²/(2·RISE) para que la subida termine EXACTAMENTE a
 * `LIFTOFF_RISE` con velocidad 0 (movimiento uniformemente decelerado):
 * v(restante) = √(2·DECEL·restante). Duración ≈ 2·RISE/v₀ = 1.2 s.
 */
const LIFTOFF_DECEL = (LIFTOFF_SPEED * LIFTOFF_SPEED) / (2 * LIFTOFF_RISE);
/** DESPEGUE — margen (u) para dar la subida por terminada y entregar al vuelo normal. */
const LIFTOFF_EPS = 0.02;

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
  // --- doble/triple salto + vuelo ---
  /** Máximo de saltos hasta tocar suelo (1 = suelo/coyote, 2 = aire, 3 = ¡vuela!). */
  private readonly maxJumps = 3;
  /** Impulso del segundo salto relativo al primero (un poco menor, eleva más). */
  private readonly doubleJumpFactor = 0.85;
  /** Saltos consumidos desde el último contacto con el suelo. */
  private jumpsUsed = 0;
  // --- vuelo (activado por el TERCER salto) ---
  /** Rapidez de crucero del vuelo (u/s). */
  private readonly flySpeed = 9;
  /** Aceleración del vuelo (suavizado hacia la velocidad objetivo). */
  private readonly flyAccel = 20;
  /** ¿En modo VUELO? (gravedad off; se mueve hacia donde mira). */
  private flying = false;
  /**
   * ¿En fase de DESPEGUE? Al entrar a vuelo DESDE EL SUELO, el controller se eleva
   * solo con una curva ease-out hasta `LIFTOFF_RISE` u sobre el suelo de despegue y
   * entonces entrega el control al vuelo normal. Ver {@link liftoffVertVel}.
   * Entrar a vuelo EN EL AIRE (3er salto, Q en el aire) NO la usa: ya viene con altura.
   */
  private liftoff = false;
  /** Y de los PIES en el instante del despegue (origen de `LIFTOFF_RISE`/`MAX_ABS`). */
  private liftoffBaseY = 0;
  /** ¿El vuelo tiene input de movimiento este frame? (para la pose del rig). */
  private flyMoving = false;
  /** Reloj del bob de flotación idle (s). */
  private flyBobT = 0;
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
    this.flying = false;
    this.flyMoving = false;
    this.liftoff = false;
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

  /**
   * ¿Puede encadenar OTRO salto en el aire ahora mismo? Cubre el doble salto Y el
   * tercero (que activa el vuelo). No aplica en vuelo (ahí el botón sirve para caer).
   */
  canDoubleJump(): boolean {
    return !this.flying && !this.grounded && this.jumpsUsed >= 1 && this.jumpsUsed < this.maxJumps;
  }

  /** ¿En modo VUELO? (para el rig, la anim de red y la etiqueta del botón "Caer"). */
  isFlying(): boolean {
    return this.flying;
  }

  /**
   * Alterna el modo VUELO — ENTRADA ALTERNATIVA al triple salto (botón "Volar" en
   * móvil, tecla Q en escritorio). NO reemplaza el triple salto: ambos caminos
   * conviven (el 3er salto sigue activando el vuelo en `update` §2).
   *   · En suelo o aire y NO vuela → entra a vuelo: gravedad off, `jumpsUsed` a tope
   *     (coherente con el 3er salto), bob reiniciado. Desde el SUELO arranca la fase
   *     de DESPEGUE (se eleva solo ~`LIFTOFF_RISE` u con ease-out: se SIENTE que vuela
   *     y de paso no re-aterriza en el mismo frame); en el aire conserva su altura
   *     (vertVel a cero, como el 3er salto: ya viene despegado).
   *   · Si YA vuela → sale: cae con gravedad normal desde reposo vertical.
   * Conserva TODO el vuelo actual (crucero, flotación idle, salto-en-vuelo = caer).
   */
  toggleFly(): void {
    this.setFlying(!this.flying);
  }

  /** Fija el modo VUELO explícitamente (idempotente). Ver {@link toggleFly}. */
  setFlying(on: boolean): void {
    if (on === this.flying) return;
    if (on) {
      const wasGrounded = this.grounded;
      this.flying = true;
      this.jumpsUsed = this.maxJumps;
      this.flyBobT = 0;
      this.grounded = false;
      // Despegue DESDE EL SUELO: fase de subida automática (§updateFly). vertVel ya
      // arranca a LIFTOFF_SPEED — positiva, así la colisión de §4 (que exige vertVel≤0)
      // no puede re-posarlo en el mismo frame. En el aire NO hay despegue ni tirón:
      // parte de reposo vertical (como el 3er salto).
      this.liftoff = wasGrounded;
      this.liftoffBaseY = this.feetY;
      this.vertVel = wasGrounded ? LIFTOFF_SPEED : 0;
    } else {
      this.flying = false;
      this.flyMoving = false;
      this.liftoff = false;
      this.vertVel = 0;
    }
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

    // --- 1. Velocidad horizontal objetivo (XZ) — en vuelo la gobierna updateFly ---
    if (!this.flying) {
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
    }

    // --- 2. Gravedad -Y + salto (coyote-time + jump-buffer) ---
    this.timeSinceGround += dt;
    this.timeSinceJumpReq += dt;
    if (intent.jump) this.timeSinceJumpReq = 0;

    const canCoyote = this.timeSinceGround <= this.coyoteTime;
    const wantsJump = this.timeSinceJumpReq <= this.jumpBuffer;
    if (this.flying) {
      // En VUELO: pulsar salto → CAER (sale del modo, gravedad normal desde reposo
      // vertical). Aterrizar también sale (§4). Edge crudo (no el buffer).
      if (intent.jump) {
        this.flying = false;
        this.flyMoving = false;
        this.liftoff = false; // cancela el despegue si aún subía
        this.vertVel = 0;
        this.timeSinceJumpReq = 999;
      }
    } else if (wantsJump && this.jumpsUsed === 0 && (this.grounded || canCoyote)) {
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
      // NUEVA pulsación de Space en el aire (edge crudo, no el buffer, para exigir
      // una pulsación real). 2º salto = impulso 0.85×; 3er salto = activa VUELO.
      this.timeSinceJumpReq = 999;
      if (this.jumpsUsed === 1) {
        // Doble salto: impulso reiniciado desde la velocidad actual → desde el ápex
        // eleva por encima de un salto simple.
        this.vertVel = this.jumpSpeed * this.doubleJumpFactor;
        this.jumpsUsed = 2;
      } else {
        // TERCER salto → VUELO: gravedad off, velocidad vertical a cero, bob reiniciado.
        // SIN fase de despegue: se activa EN EL AIRE, ya viene con la altura de dos saltos.
        this.flying = true;
        this.jumpsUsed = 3;
        this.vertVel = 0;
        this.flyBobT = 0;
        this.liftoff = false;
      }
    }

    if (this.flying) {
      // Vuelo: sustituye gravedad + accel horizontal por una velocidad 3D suave.
      this.updateFly(dt, intent);
    } else {
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
      this.jumpsUsed = 0; // al aterrizar se recarga el doble/triple salto
      this.flying = false; // aterrizar SIEMPRE sale del modo vuelo
      this.flyMoving = false;
      this.liftoff = false;
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
    // En vuelo: pose de aire ("jump") mientras te mueves; "idle" al flotar quieto
    // (se ve mejor la flotación). En tierra/salto: pose de aire si no hay suelo.
    const rigJumping = this.flying ? this.flyMoving : !this.grounded;
    this.rig?.update(dt, {
      speed: this.horizVel.length(),
      maxSpeed: this.runSpeed,
      grounded: this.grounded && !this.flying,
      jumping: rigJumping,
      flying: this.flying,
    });

    this.updateBlob();
  }

  /**
   * Física de VUELO: dirección deseada 3D = worldDir plano (horizontal) + una
   * componente VERTICAL derivada del pitch de la mirada (`intent.lookDir`) por
   * cuánto el movimiento va "hacia delante" respecto a la cámara. Así, mirar
   * arriba y avanzar (W) sube; mirar abajo baja; el strafe queda nivelado. La
   * velocidad 3D se suaviza (flyAccel). Sin input: la velocidad decae a cero y se
   * añade un bob CON EASE, sutil (flotación idle delicada). NO hay gravedad aquí.
   *   Excepción: durante la fase de DESPEGUE (entrada a vuelo desde el suelo) la
   * vertical la gobierna {@link liftoffVertVel} — el suavizado de arriba la apagaría
   * en un suspiro (objetivo 0 sin input, flyAccel 20) y el avatar apenas se despegaría.
   * El control HORIZONTAL sigue siendo del jugador durante todo el despegue.
   */
  private updateFly(dt: number, intent: MoveIntent): void {
    TMP.desired.copy(intent.worldDir);
    TMP.desired.y = 0;
    const hasInput = TMP.desired.lengthSq() > 1e-6 && intent.throttle > 0.02;
    this.flyMoving = hasInput;

    TMP.flyTarget.set(0, 0, 0);
    if (hasInput) {
      TMP.desired.normalize();
      let vy = 0;
      const look = intent.lookDir;
      if (look && look.lengthSq() > 1e-6) {
        // Alineación del movimiento con el frente HORIZONTAL de la cámara: +1 = W
        // (hacia donde miras), −1 = S. Multiplica el seno del pitch (look.y).
        const lhLen = Math.hypot(look.x, look.z);
        let align = 0;
        if (lhLen > 1e-5) align = (TMP.desired.x * look.x + TMP.desired.z * look.z) / lhLen;
        align = THREE.MathUtils.clamp(align, -1, 1);
        vy = look.y * align;
      }
      TMP.flyTarget.set(TMP.desired.x, vy, TMP.desired.z);
      if (TMP.flyTarget.lengthSq() > 1e-8) {
        TMP.flyTarget.normalize().multiplyScalar(this.flySpeed * Math.min(1, intent.throttle));
      }
    }

    // Suaviza la velocidad 3D actual (horizVel.xz + vertVel.y) hacia el objetivo.
    const step = this.flyAccel * dt;
    const cx = this.horizVel.x;
    const cz = this.horizVel.z;
    const cy = this.vertVel;
    const dx = TMP.flyTarget.x - cx;
    const dy = TMP.flyTarget.y - cy;
    const dz = TMP.flyTarget.z - cz;
    const dl = Math.hypot(dx, dy, dz);
    if (dl <= step || dl < 1e-6) {
      this.horizVel.set(TMP.flyTarget.x, 0, TMP.flyTarget.z);
      this.vertVel = TMP.flyTarget.y;
    } else {
      const k = step / dl;
      this.horizVel.set(cx + dx * k, 0, cz + dz * k);
      this.vertVel = cy + dy * k;
    }

    // Flotación idle SUTIL CON EASE: sin input, un flote delicado ±FLY_BOB_AMP u
    // @0.35 Hz sumado a la velocidad vertical (su integral es el desplazamiento, no
    // acumula deriva porque la velocidad base decae a 0).
    //   Desplazamiento = FLY_BOB_AMP · ease(sin φ),  ease(u) = 1.5u − 0.5u³.
    // La curva `ease` REDONDEA cimas y valles (pendiente nula en los extremos: el
    // flote se demora gentilmente arriba y abajo) → se siente un flote con ease, no
    // un balanceo mecánico. Sumamos su DERIVADA temporal exacta como velocidad:
    //   d/dt = FLY_BOB_AMP · ease'(sin φ) · cos φ · FLY_BOB_W,  ease'(u) = 1.5 − 1.5u².
    if (this.liftoff) {
      // DESPEGUE en curso: manda la curva (ignora bob y la vy de la mirada). El
      // jugador SÍ conserva el control HORIZONTAL (lo de arriba no se toca).
      // Salvedad: si pide bajar EXPLÍCITAMENTE (mira abajo y avanza), se entrega ya
      // el control — nunca se le lleva a donde no quiere ir.
      if (TMP.flyTarget.y < -0.5) this.liftoff = false;
      else this.vertVel = this.liftoffVertVel(dt);
    } else if (!hasInput) {
      this.flyBobT += dt;
      const phase = FLY_BOB_W * this.flyBobT;
      const s = Math.sin(phase);
      const easeDeriv = 1.5 - 1.5 * s * s; // ease'(u) con u = sin φ
      this.vertVel += FLY_BOB_AMP * FLY_BOB_W * easeDeriv * Math.cos(phase);
    }
  }

  /**
   * Velocidad vertical (u/s) de la fase de DESPEGUE, y su final. Curva EASE-OUT por
   * movimiento uniformemente decelerado: v = √(2·LIFTOFF_DECEL·restante) — sale fuerte
   * (LIFTOFF_SPEED) y se demora al acercarse a `LIFTOFF_RISE`, donde llega con v≈0 y
   * ENTREGA el control al vuelo normal (a partir de ahí el jugador sube cuanto quiera
   * mirando arriba: el tope es SÓLO del despegue automático, no un techo de vuelo).
   * Siempre devuelve v > 0 mientras dura → la colisión de §4 (exige vertVel≤0) no puede
   * re-posar al avatar en el suelo que acaba de dejar.
   */
  private liftoffVertVel(dt: number): number {
    const rise = this.feetY - this.liftoffBaseY;
    const remaining = LIFTOFF_RISE - rise;
    // Llegó (o el tope duro dice basta): entrega al vuelo normal.
    if (remaining <= LIFTOFF_EPS || rise >= LIFTOFF_MAX_ABS - LIFTOFF_EPS) {
      this.liftoff = false;
      this.flyBobT = 0; // la flotación idle arranca limpia desde el punto neutro
      return 0;
    }
    let v = Math.sqrt(2 * LIFTOFF_DECEL * remaining);
    // Sin sobrepasar: ni el objetivo (último frame: justo lo que falta) ni el tope duro.
    v = Math.min(v, remaining / dt, (LIFTOFF_MAX_ABS - rise) / dt);
    return v;
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
