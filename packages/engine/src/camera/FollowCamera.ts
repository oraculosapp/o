import * as THREE from "three";
import type { CharacterController } from "../controller/CharacterController";

/**
 * Cámara de tercera persona con up dinámico (sigue la normal del planeta).
 * Órbita manual con drag; vuelve suavemente detrás del personaje tras ~2 s
 * sin input (estilo Messenger). Zoom con límites. Damping en posición y up
 * para que no haya saltos al cruzar el planeta.
 */
export class FollowCamera {
  private yaw = 0; // offset azimutal alrededor del up (0 = detrás)
  // Pitch bajo (~19°): más horizonte en cuadro → desde el spawn se ven las
  // laderas del anfiteatro alzándose tras la runa, fundidas en la niebla.
  private pitch = 0.34; // elevación sobre el hombro (rad)
  private distance = 7.5;
  private readonly minDist = 4;
  private readonly maxDist = 12;
  private readonly minPitch = 0.06;
  private readonly maxPitch = 1.15;

  private idleTime = 0;
  private readonly returnDelay = 2.0; // s sin input → vuelve detrás
  private manualYaw = false;

  // Estado suavizado.
  private smoothUp = new THREE.Vector3(0, 1, 0);
  private smoothPos = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

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
    this.yaw -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.005, this.minPitch, this.maxPitch);
    this.idleTime = 0;
    this.manualYaw = true;
  }

  zoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, this.minDist, this.maxDist);
  }

  update(dt: number, force = false): void {
    this.idleTime += dt;

    const charPos = this.target.position;
    const up = charPos.clone().normalize();

    // Tras el retardo, la órbita vuelve suavemente a 0 (detrás del personaje).
    if (this.manualYaw && this.idleTime > this.returnDelay) {
      const k = 1 - Math.exp(-2.5 * dt);
      this.yaw = THREE.MathUtils.lerp(this.yaw, 0, k);
      if (Math.abs(this.yaw) < 0.002) {
        this.yaw = 0;
        this.manualYaw = false;
      }
    }

    // Base de órbita a partir del frente del personaje, proyectado al tangente.
    const fwd = this.target.getForward().clone();
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-5) fwd.set(1, 0, 0);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();

    // Boom: detrás del personaje = -fwd, girado por yaw y elevado por pitch.
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const horiz = new THREE.Vector3()
      .addScaledVector(fwd, -cosY)
      .addScaledVector(right, sinY); // dirección horizontal desde el personaje a la cámara
    const boom = new THREE.Vector3()
      .addScaledVector(horiz, Math.cos(this.pitch))
      .addScaledVector(up, Math.sin(this.pitch))
      .normalize();

    const shoulder = charPos.clone().addScaledVector(up, 1.7);
    const desiredPos = shoulder.clone().addScaledVector(boom, this.distance);

    if (!this.initialized || force) {
      this.smoothPos.copy(desiredPos);
      this.smoothTarget.copy(shoulder);
      this.smoothUp.copy(up);
    } else {
      const kPos = 1 - Math.exp(-9 * dt);
      const kUp = 1 - Math.exp(-5 * dt); // up más lento = giros suaves al rodar
      this.smoothPos.lerp(desiredPos, kPos);
      this.smoothTarget.lerp(shoulder, kPos);
      this.smoothUp.lerp(up, kUp).normalize();
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.up.copy(this.smoothUp);
    this.camera.lookAt(this.smoothTarget);
  }
}
