import * as THREE from "three";
import type { CharacterController } from "../controller/CharacterController";

/**
 * Cámara de tercera persona PLANAR (up constante (0,1,0)), estilo Messenger.
 *
 * El boom vive en AZIMUT DE MUNDO (`boomAz`), desacoplado del frente
 * instantáneo del avatar: girar el personaje NO arrastra la cámara. Política de
 * auto-retorno (rediseño S3b tras feedback del director — "caminar hacia la
 * cámara volteaba el mundo"):
 *  (a) NUNCA recentra mientras el movimiento tiene componente hacia la cámara
 *      (dot(dirMov, forwardCám) < DOT_FREEZE) ni en movimiento lateral;
 *  (b) recentra sólo tras >AWAY_DELAY s moviéndose claramente en alejamiento
 *      (dot > DOT_AWAY) o tras >STILL_DELAY s quieto;
 *  (c) tasa de retorno suave exp(−RETURN_RATE·dt).
 * Resultado: caminar hacia la cámara = el avatar viene hacia ti y la cámara no
 * se mueve. Conserva órbita manual (YAW_DIR/PITCH_DIR invertidos "vuelo"),
 * zoom con límites y damping de posición exp(−9·dt) aprobado.
 */
export class FollowCamera {
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  /** Azimut de mundo del boom (dirección personaje→cámara en XZ). */
  private boomAz = Math.PI / 2;
  // Pitch bajo (~19°): más horizonte → laderas del anfiteatro y abismo brumoso.
  private pitch = 0.34;
  private distance = 7.5;
  private readonly minDist = 4;
  private readonly maxDist = 12;
  private readonly minPitch = 0.06;
  private readonly maxPitch = 1.15;

  /** +1 = "vuelo" (arrastrar abajo mira arriba) · -1 = clásico. (S2.5, dirección.) */
  private static readonly PITCH_DIR = 1;
  /** Dirección del arrastre horizontal: +1 = invertido "vuelo" · -1 = clásico. */
  private static readonly YAW_DIR = 1;
  /** Sensibilidad de órbita (rad/px). Yaw 0.0035 (antes 0.005: nervioso, S3b). */
  private static readonly SENS_YAW = 0.0035;
  private static readonly SENS_PITCH = 0.005;

  // --- política de auto-retorno (S3b) ---
  /** dot(dirMov, forwardCám) bajo el cual el retorno queda CONGELADO. */
  private static readonly DOT_FREEZE = 0.2;
  /** dot sobre el cual el movimiento cuenta como "alejamiento claro". */
  private static readonly DOT_AWAY = 0.5;
  /** s de alejamiento claro continuo antes de permitir recentrar. */
  private static readonly AWAY_DELAY = 1.5;
  /** s quieto antes de permitir recentrar. */
  private static readonly STILL_DELAY = 2.5;
  /** Tasa exponencial del recentrado (antes 2.5, más agresiva). */
  private static readonly RETURN_RATE = 2;
  /** Rapidez horizontal (u/s) mínima para contar como "en movimiento". */
  private static readonly MOVE_MIN = 0.5;

  private awayTime = 0;
  private stillTime = 0;

  /**
   * Auto-retorno activo. Con `prefers-reduced-motion` (o el override de UI) el
   * mundo apaga el recentrado automático: la cámara sólo se mueve con input del
   * usuario (órbita/zoom). No afecta al seguimiento de posición ni a la órbita.
   */
  private autoReturn = true;

  private smoothPos = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

  // --- inset de viewport para HUD lateral (Contrato A) ---
  /** Márgenes CSS (px) que ocupa el HUD; el encuadre se recentra en lo visible. */
  private inset = { left: 0, right: 0, top: 0, bottom: 0 };

  // Scratch.
  private _fwd = new THREE.Vector3();
  private _vel = new THREE.Vector3();
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
    this.target.getForward(this._fwd);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-5) this._fwd.set(0, 0, -1);
    // Detrás del avatar: azimut de -forward.
    this.boomAz = Math.atan2(-this._fwd.z, -this._fwd.x);
    this.awayTime = 0;
    this.stillTime = 0;
    this.update(0, true);
    this.smoothPos.copy(this.camera.position);
    this.initialized = true;
  }

  orbit(dx: number, dy: number): void {
    this.boomAz += FollowCamera.YAW_DIR * dx * FollowCamera.SENS_YAW;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + FollowCamera.PITCH_DIR * dy * FollowCamera.SENS_PITCH,
      this.minPitch,
      this.maxPitch,
    );
    // El drag manual reinicia la política: nada de recentres inmediatos encima.
    this.awayTime = 0;
    this.stillTime = 0;
  }

  zoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, this.minDist, this.maxDist);
  }

  /**
   * Contrato A — recentra el encuadre en el ÁREA VISIBLE cuando el HUD (p.ej. el
   * chat como columna a la derecha) tapa parte del lienzo. Usa `camera.setViewOffset`
   * de three.js: desplaza el punto principal de la proyección para que el avatar/
   * tótem quede centrado en lo que se ve, sin recortar ni hacer zoom.
   *
   * `fullW`/`fullH` = tamaño CSS del lienzo (px). El desplazamiento del principal
   * es (right−left)/2 en x y (bottom−top)/2 en y (fracción del frustum, así el
   * corrimiento en px es exacto e independiente del devicePixelRatio). Con todos
   * los insets a 0 se limpia el offset (comportamiento normal). Reaplica en resize.
   */
  setViewportInset(
    inset: { left?: number; right?: number; top?: number; bottom?: number },
    fullW: number,
    fullH: number,
  ): void {
    this.inset = {
      left: inset.left ?? 0,
      right: inset.right ?? 0,
      top: inset.top ?? 0,
      bottom: inset.bottom ?? 0,
    };
    this.applyViewOffset(fullW, fullH);
  }

  /** (Re)aplica el offset de vista con el tamaño actual del lienzo (px CSS). */
  applyViewOffset(fullW: number, fullH: number): void {
    const { left, right, top, bottom } = this.inset;
    if (fullW <= 0 || fullH <= 0) return;
    if (!left && !right && !top && !bottom) {
      this.camera.clearViewOffset();
      return;
    }
    // Desplaza el principal hacia el centro del área visible.
    const offX = (right - left) / 2;
    const offY = (bottom - top) / 2;
    this.camera.setViewOffset(fullW, fullH, offX, offY, fullW, fullH);
  }

  /** Activa/desactiva el auto-retorno (lo apaga el modo movimiento reducido). */
  setAutoReturn(enabled: boolean): void {
    this.autoReturn = enabled;
    if (!enabled) {
      this.awayTime = 0;
      this.stillTime = 0;
    }
  }

  update(dt: number, force = false): void {
    const up = FollowCamera.UP;
    const charPos = this.target.position;

    // --- política de auto-retorno ---
    const speed = this.target.getHorizVelocity(this._vel).length();
    // forward de cámara en XZ = del ojo hacia el personaje = -boom.
    const lookX = -Math.cos(this.boomAz);
    const lookZ = -Math.sin(this.boomAz);
    if (speed > FollowCamera.MOVE_MIN) {
      this.stillTime = 0;
      const dot = (this._vel.x * lookX + this._vel.z * lookZ) / speed;
      // Sólo el alejamiento claro acumula; hacia la cámara (< DOT_FREEZE) o
      // lateral (< DOT_AWAY) congela el retorno.
      this.awayTime = dot > FollowCamera.DOT_AWAY ? this.awayTime + dt : 0;
    } else {
      this.awayTime = 0;
      this.stillTime += dt;
    }

    const mayReturn =
      this.autoReturn &&
      (this.awayTime > FollowCamera.AWAY_DELAY || this.stillTime > FollowCamera.STILL_DELAY);
    if (mayReturn && dt > 0) {
      // Recentra suavemente detrás del avatar (por el camino angular corto).
      this.target.getForward(this._fwd);
      this._fwd.y = 0;
      if (this._fwd.lengthSq() > 1e-5) {
        const targetAz = Math.atan2(-this._fwd.z, -this._fwd.x);
        const delta = Math.atan2(Math.sin(targetAz - this.boomAz), Math.cos(targetAz - this.boomAz));
        this.boomAz += delta * (1 - Math.exp(-FollowCamera.RETURN_RATE * dt));
      }
    }

    // --- boom en azimut de mundo ---
    this._horiz.set(Math.cos(this.boomAz), 0, Math.sin(this.boomAz));
    this._boom
      .copy(this._horiz)
      .multiplyScalar(Math.cos(this.pitch))
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
