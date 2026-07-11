import * as THREE from "three";

/** Estado de movimiento consumido cada frame por el mundo. */
export interface InputFrame {
  /** x = strafe (-1 izq .. +1 der), y = avance (-1 atrás .. +1 frente). Relativo a cámara. */
  moveAxis: THREE.Vector2;
  run: boolean;
  /** true sólo el frame en que se presionó saltar (edge). */
  jump: boolean;
}

interface PointerRec {
  id: number;
  role: "orbit" | "joystick";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  startT: number;
}

/**
 * Input triple sin dependencias de framework (no importa React/Next):
 * - Teclado: WASD + flechas (relativo a cámara), Shift correr, Space saltar.
 * - Mouse: drag = orbitar cámara; click corto sobre el terreno = tap-to-move.
 * - Táctil: joystick virtual en la mitad izquierda (aparece donde tocas),
 *   drag en la mitad derecha = cámara, tap corto = tap-to-move.
 * Detecta touch por `pointerType` del evento, nunca por user-agent.
 */
export class InputManager {
  private keys = new Set<string>();
  private jumpEdge = false;
  private pointers = new Map<number, PointerRec>();

  private orbitDX = 0;
  private orbitDY = 0;
  private zoomDelta = 0;
  private joyVec = new THREE.Vector2(); // -1..1 desde el joystick táctil

  /** Callback de tap-to-move con coords NDC (-1..1). Lo fija el mundo. */
  onTap: ((ndcX: number, ndcY: number) => void) | null = null;
  /** Se llama cuando el usuario da input manual de movimiento (cancela tap-to-move). */
  onManualMove: (() => void) | null = null;

  // Joystick DOM (creado por el motor, no por React).
  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;
  private readonly joyRadius = 46;

  private _axis = new THREE.Vector2();

  constructor(private el: HTMLElement) {
    this.joyBase = document.createElement("div");
    this.joyKnob = document.createElement("div");
    this.setupJoystickDom();
    this.attach();
  }

  private setupJoystickDom(): void {
    Object.assign(this.joyBase.style, {
      position: "absolute",
      width: `${this.joyRadius * 2}px`,
      height: `${this.joyRadius * 2}px`,
      borderRadius: "50%",
      border: "2px solid rgba(227,176,99,0.55)",
      background: "radial-gradient(circle, rgba(227,176,99,0.10), rgba(10,12,22,0.25))",
      pointerEvents: "none",
      transform: "translate(-50%, -50%)",
      display: "none",
      zIndex: "5",
      touchAction: "none",
    } as CSSStyleDeclaration);
    Object.assign(this.joyKnob.style, {
      position: "absolute",
      width: "38px",
      height: "38px",
      borderRadius: "50%",
      background: "rgba(227,176,99,0.85)",
      boxShadow: "0 0 14px rgba(227,176,99,0.6)",
      pointerEvents: "none",
      transform: "translate(-50%, -50%)",
      left: "50%",
      top: "50%",
    } as CSSStyleDeclaration);
    this.joyBase.appendChild(this.joyKnob);
    // El contenedor debe ser posicionado para que absolute funcione.
    if (getComputedStyle(this.el).position === "static") this.el.style.position = "relative";
    this.el.appendChild(this.joyBase);
  }

  private attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.el.addEventListener("pointerdown", this.onPointerDown);
    this.el.addEventListener("pointermove", this.onPointerMove);
    this.el.addEventListener("pointerup", this.onPointerUp);
    this.el.addEventListener("pointercancel", this.onPointerUp);
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    this.el.addEventListener("contextmenu", this.preventCtx);
  }

  // ---- teclado ----

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (k === " " || k === "spacebar") {
      if (!this.keys.has(" ")) this.jumpEdge = true;
      this.keys.add(" ");
      e.preventDefault();
    } else {
      this.keys.add(k);
    }
    if (this.isMoveKey(k)) this.onManualMove?.();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
    if (e.key === " ") this.keys.delete(" ");
  };

  private isMoveKey(k: string): boolean {
    return (
      k === "w" || k === "a" || k === "s" || k === "d" ||
      k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright"
    );
  }

  // ---- puntero (mouse + touch) ----

  private onPointerDown = (e: PointerEvent): void => {
    (this.el as HTMLElement).setPointerCapture?.(e.pointerId);
    const isTouch = e.pointerType === "touch";
    const rect = this.el.getBoundingClientRect();
    const leftHalf = e.clientX - rect.left < rect.width / 2;

    let role: PointerRec["role"] = "orbit";
    if (isTouch && leftHalf && !this.hasRole("joystick")) {
      role = "joystick";
      this.joyBase.style.left = `${e.clientX - rect.left}px`;
      this.joyBase.style.top = `${e.clientY - rect.top}px`;
      this.joyBase.style.display = "block";
      this.joyKnob.style.left = "50%";
      this.joyKnob.style.top = "50%";
    }
    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      role,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      startT: performance.now(),
    });
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 6) p.moved = true;

    if (p.role === "orbit") {
      this.orbitDX += dx;
      this.orbitDY += dy;
    } else {
      // Joystick: vector desde el centro, clamp al radio → eje -1..1.
      const vx = e.clientX - p.startX;
      const vy = e.clientY - p.startY;
      const len = Math.hypot(vx, vy);
      const cl = Math.min(len, this.joyRadius);
      const nx = len > 0 ? (vx / len) * cl : 0;
      const ny = len > 0 ? (vy / len) * cl : 0;
      this.joyKnob.style.left = `${this.joyRadius + nx}px`;
      this.joyKnob.style.top = `${this.joyRadius + ny}px`;
      this.joyVec.set(nx / this.joyRadius, -ny / this.joyRadius); // y arriba = frente
      if (this.joyVec.lengthSq() > 0.01) this.onManualMove?.();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);

    if (p.role === "joystick") {
      this.joyVec.set(0, 0);
      if (!this.hasRole("joystick")) this.joyBase.style.display = "none";
    } else {
      // Tap corto sin arrastre → tap-to-move.
      const dt = performance.now() - p.startT;
      if (!p.moved && dt < 300 && this.onTap) {
        const rect = this.el.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        this.onTap(ndcX, ndcY);
      }
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomDelta += e.deltaY * 0.01;
  };

  private preventCtx = (e: Event): void => e.preventDefault();

  private hasRole(role: PointerRec["role"]): boolean {
    for (const p of this.pointers.values()) if (p.role === role) return true;
    return false;
  }

  // ---- consumo por frame ----

  /** Eje de movimiento (teclado o joystick), run y edge de salto. */
  consumeMove(): InputFrame {
    this._axis.set(0, 0);
    if (this.joyVec.lengthSq() > 0.001) {
      this._axis.copy(this.joyVec);
    } else {
      if (this.keys.has("w") || this.keys.has("arrowup")) this._axis.y += 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) this._axis.y -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) this._axis.x += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) this._axis.x -= 1;
      if (this._axis.lengthSq() > 1) this._axis.normalize();
    }
    const run = this.keys.has("shift");
    const jump = this.jumpEdge;
    this.jumpEdge = false;
    return { moveAxis: this._axis, run, jump };
  }

  /** Deltas de órbita acumulados (px) y los resetea. */
  consumeOrbit(): { dx: number; dy: number } {
    const r = { dx: this.orbitDX, dy: this.orbitDY };
    this.orbitDX = 0;
    this.orbitDY = 0;
    return r;
  }

  /** Delta de zoom acumulado y lo resetea. */
  consumeZoom(): number {
    const z = this.zoomDelta;
    this.zoomDelta = 0;
    return z;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("pointermove", this.onPointerMove);
    this.el.removeEventListener("pointerup", this.onPointerUp);
    this.el.removeEventListener("pointercancel", this.onPointerUp);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("contextmenu", this.preventCtx);
    this.joyBase.remove();
  }
}
