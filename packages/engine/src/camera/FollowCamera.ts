import * as THREE from "three";
import type { CharacterController } from "../controller/CharacterController";

/**
 * Cámara de tercera persona PLANAR (up constante (0,1,0)). Órbita manual con
 * drag; vuelve suavemente detrás del personaje tras ~2 s sin input (estilo
 * Messenger). Zoom con límites. Damping en posición para que no haya saltos.
 * Conserva la órbita con auto-retorno, el zoom y PITCH_DIR invertido ("vuelo").
 */
export class FollowCamera {
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  private yaw = 0; // offset azimutal alrededor del up (0 = detrás)
  // Pitch bajo (~19°): más horizonte → se ven las laderas del anfiteatro tras
  // la runa y, mirando lejos, el abismo brumoso bajo la isla.
  private pitch = 0.34;
  private distance = 7.5;
  private readonly minDist = 4;
  private readonly maxDist = 12;
  private readonly minPitch = 0.06;
  private readonly maxPitch = 1.15;

  /** +1 = "vuelo" (arrastrar abajo mira arriba) · -1 = clásico. (S2.5, dirección.) */
  private static readonly PITCH_DIR = 1;
  /**
   * Dirección del arrastre horizontal — feedback del director jugando la isla:
   * el eje también va invertido respecto al clásico (mismo criterio "vuelo" que
   * PITCH_DIR). +1 = invertido · -1 = clásico (el `yaw -=` original). Mouse y
   * táctil pasan ambos por orbit() → consistentes. Setting de usuario a futuro.
   */
  private static readonly YAW_DIR = 1;

  private idleTime = 0;
  private readonly returnDelay = 2.0;
  private manualYaw = false;

  private smoothPos = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

  // Scratch.
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _horiz = new THREE.Vector3();
  private _boom = new THREE.Vector3();
  private _shoulder = new THREE.Vector3();
  private _desired = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private target: CharacterController,
  ) {}

  /** Coloca la cámara detrás del avatar en el primer frame (encuadre bonito). */
  snapBehind(): void {
    this.yaw = 0;
    this.idleTime = this.returnDelay;
    this.update(0, true);
    this.smoothPos.copy(this.camera.position);
    this.initialized = true;
  }

  orbit(dx: number, dy: number): void {
    this.yaw += FollowCamera.YAW_DIR * dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + FollowCamera.PITCH_DIR * dy * 0.005,
      this.minPitch,
      this.maxPitch,
    );
    this.idleTime = 0;
    this.manualYaw = true;
  }

  zoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, this.minDist, this.maxDist);
  }

  update(dt: number, force = false): void {
    this.idleTime += dt;
    const up = FollowCamera.UP;
    const charPos = this.target.position;

    if (this.manualYaw && this.idleTime > this.returnDelay) {
      const k = 1 - Math.exp(-2.5 * dt);
      this.yaw = THREE.MathUtils.lerp(this.yaw, 0, k);
      if (Math.abs(this.yaw) < 0.002) {
        this.yaw = 0;
        this.manualYaw = false;
      }
    }

    // Frente del personaje proyectado a XZ.
    this.target.getForward(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-5) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.crossVectors(up, this._fwd).normalize();

    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    this._horiz.set(0, 0, 0).addScaledVector(this._fwd, -cosY).addScaledVector(this._right, sinY);
    this._boom
      .set(0, 0, 0)
      .addScaledVector(this._horiz, Math.cos(this.pitch))
      .addScaledVector(up, Math.sin(this.pitch))
      .normalize();

    this._shoulder.copy(charPos).addScaledVector(up, 1.7);
    this._desired.copy(this._shoulder).addScaledVector(this._boom, this.distance);

    if (!this.initialized || force) {
      this.smoothPos.copy(this._desired);
      this.smoothTarget.copy(this._shoulder);
    } else {
      const kPos = 1 - Math.exp(-9 * dt);
      this.smoothPos.lerp(this._desired, kPos);
      this.smoothTarget.lerp(this._shoulder, kPos);
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.up.copy(up);
    this.camera.lookAt(this.smoothTarget);
  }
}
