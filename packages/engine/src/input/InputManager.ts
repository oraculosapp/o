import * as THREE from "three";

/** Estado de movimiento consumido cada frame por el mundo. */
export interface InputFrame {
  /** x = strafe (-1 izq .. +1 der), y = avance (-1 atrás .. +1 frente). Relativo a cámara. */
  moveAxis: THREE.Vector2;
  run: boolean;
  /** true sólo el frame en que se presionó saltar (edge). */
  jump: boolean;
  /** true sólo el frame en que se presionó E (agarrar/lanzar, edge). */
  grab: boolean;
}

/**
 * Estado de acción del personaje que la UI móvil observa para dibujar los botones
 * de Saltar y Agarrar/Lanzar (Contrato B). El mundo lo empuja cada frame; el
 * InputManager sólo notifica a los suscriptores cuando cambia.
 */
export interface ActionState {
  /** Hay una pelota agarrable al alcance (y no llevas ninguna). */
  canGrab: boolean;
  /** El personaje sostiene una pelota (el botón pasa a "Lanzar"). */
  holding: boolean;
  /** Pegado al suelo. */
  grounded: boolean;
  /** Puede encadenar un segundo salto en el aire (doble salto). */
  canDoubleJump: boolean;
  /** En modo VUELO (triple salto): el botón de salto pasa a "Caer". */
  flying: boolean;
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
  private grabEdge = false;
  /** Correr desde el botón MÓVIL (hold): OR con Shift del teclado. */
  private mobileRun = false;
  private pointers = new Map<number, PointerRec>();

  /**
   * Interruptor maestro del input del juego. Cuando es `false` (p.ej. el chat
   * tomó foco), el teclado del juego se ignora y `consumeMove` devuelve un frame
   * neutro: el avatar no se mueve y Space/Enter NO se consumen (llegan al campo
   * de texto). Lo gobierna `world.setInputEnabled(bool)` desde la UI.
   */
  private inputEnabled = true;

  // Estado de acción (Contrato B) + suscriptores. Lo empuja el mundo cada frame.
  private actionSubs = new Set<(s: ActionState) => void>();
  private actionState: ActionState = {
    canGrab: false,
    holding: false,
    grounded: true,
    canDoubleJump: false,
    flying: false,
  };

  private orbitDX = 0;
  private orbitDY = 0;
  private zoomDelta = 0;
  private joyVec = new THREE.Vector2(); // -1..1 desde el joystick táctil

  // Puntero continuo en NDC (-1..1) para el campo magnético de las partículas.
  // Mouse: sigue el hover. Táctil: sólo mientras un dedo arrastra.
  private pointerNdc = new THREE.Vector2();
  private pointerActive = false;

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
    this.el.addEventListener("pointerleave", this.onPointerLeave);
    this.el.addEventListener("wheel", this.onWheel, { passive: false });
    this.el.addEventListener("contextmenu", this.preventCtx);
  }

  // ---- teclado ----

  private onKeyDown = (e: KeyboardEvent): void => {
    // BUG-FIX: el teclado del juego (WASD/flechas/Space/Shift/E) se IGNORA cuando
    // el foco está en un campo editable (input/textarea/select/contenteditable) o
    // cuando la UI apagó el input (chat con foco). Crucial: NO hacemos
    // preventDefault → Space/Enter llegan al campo de texto y escriben normal.
    if (!this.inputEnabled || InputManager.isEditableTarget(e)) return;

    const k = e.key.toLowerCase();
    if (k === " " || k === "spacebar") {
      if (!this.keys.has(" ")) this.jumpEdge = true;
      this.keys.add(" ");
      e.preventDefault();
    } else if (k === "e") {
      // Edge de agarrar/lanzar (una emisión por pulsación, no por auto-repeat).
      if (!this.keys.has("e")) this.grabEdge = true;
      this.keys.add("e");
    } else {
      this.keys.add(k);
    }
    if (this.isMoveKey(k)) this.onManualMove?.();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // El keyup limpia SIEMPRE (aunque el input esté deshabilitado) para no dejar
    // una tecla "pegada" si el estado cambió mientras estaba pulsada.
    const k = e.key.toLowerCase();
    this.keys.delete(k);
    if (k === " ") this.keys.delete(" ");
  };

  private isMoveKey(k: string): boolean {
    return (
      k === "w" || k === "a" || k === "s" || k === "d" ||
      k === "arrowup" || k === "arrowdown" || k === "arrowleft" || k === "arrowright"
    );
  }

  /** ¿El evento de teclado nace de (o el foco está en) un campo editable? */
  private static isEditableTarget(e: KeyboardEvent): boolean {
    if (InputManager.isEditable(e.target as Element | null)) return true;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    return InputManager.isEditable(active);
  }

  private static isEditable(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return (el as HTMLElement).isContentEditable === true;
  }

  /**
   * Enciende/apaga el input del juego (Contrato UI). Al apagar, suelta cualquier
   * tecla mantenida y anula el joystick para que el avatar se detenga en seco.
   */
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.joyVec.set(0, 0);
      this.jumpEdge = false;
      this.grabEdge = false;
      this.mobileRun = false; // suelta el correr móvil al perder el input
    }
  }

  /** ¿El input del juego está habilitado? */
  isInputEnabled(): boolean {
    return this.inputEnabled;
  }

  // ---- Contrato B: acciones móviles (sin teclado) ----

  /** Encola un salto (botón móvil). Da el primer salto o el doble salto en aire. */
  pressJump(): void {
    this.jumpEdge = true;
  }

  /** Encola un E (botón móvil): agarra la pelota cercana o lanza la que llevas. */
  pressGrab(): void {
    this.grabEdge = true;
  }

  /**
   * Botón CORRER móvil en modo HOLD (feel arcade): mantén pulsado para correr,
   * suelta para caminar. Se combina (OR) con Shift del teclado en `consumeMove`.
   */
  setRun(on: boolean): void {
    this.mobileRun = on;
  }

  /** Botón CORRER móvil en modo TOGGLE (alterna correr/caminar en cada pulsación). */
  pressRun(): void {
    this.mobileRun = !this.mobileRun;
  }

  /**
   * Suscribe cambios del estado de acción (canGrab/holding/grounded/canDoubleJump).
   * Llama al callback de inmediato con el estado actual y luego sólo en cambios.
   * Devuelve la función para desuscribir.
   */
  onActionState(cb: (s: ActionState) => void): () => void {
    this.actionSubs.add(cb);
    cb({ ...this.actionState });
    return () => this.actionSubs.delete(cb);
  }

  /** El mundo empuja el estado de acción cada frame; notifica sólo si cambió. */
  setActionState(s: ActionState): void {
    const p = this.actionState;
    if (
      p.canGrab === s.canGrab &&
      p.holding === s.holding &&
      p.grounded === s.grounded &&
      p.canDoubleJump === s.canDoubleJump &&
      p.flying === s.flying
    ) {
      return;
    }
    this.actionState = { ...s };
    for (const cb of this.actionSubs) cb({ ...this.actionState });
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
    // Puntero continuo para el campo magnético (hover de mouse o arrastre táctil).
    const rectN = this.el.getBoundingClientRect();
    this.pointerNdc.set(
      ((e.clientX - rectN.left) / rectN.width) * 2 - 1,
      -(((e.clientY - rectN.top) / rectN.height) * 2 - 1),
    );
    // El mouse ejerce campo al pasar (hover); el táctil sólo mientras toca.
    this.pointerActive = e.pointerType !== "touch" || this.pointers.has(e.pointerId);

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

  private onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") this.pointerActive = false;
  };

  private onPointerUp = (e: PointerEvent): void => {
    // El dedo deja de ejercer campo al levantarse.
    if (e.pointerType === "touch") this.pointerActive = false;
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

  /** Eje de movimiento (teclado o joystick), run y edges de salto/agarrar. */
  consumeMove(): InputFrame {
    this._axis.set(0, 0);
    // Input del juego apagado (chat con foco): frame neutro, edges descartados.
    if (!this.inputEnabled) {
      this.jumpEdge = false;
      this.grabEdge = false;
      return { moveAxis: this._axis, run: false, jump: false, grab: false };
    }
    if (this.joyVec.lengthSq() > 0.001) {
      this._axis.copy(this.joyVec);
    } else {
      if (this.keys.has("w") || this.keys.has("arrowup")) this._axis.y += 1;
      if (this.keys.has("s") || this.keys.has("arrowdown")) this._axis.y -= 1;
      if (this.keys.has("d") || this.keys.has("arrowright")) this._axis.x += 1;
      if (this.keys.has("a") || this.keys.has("arrowleft")) this._axis.x -= 1;
      if (this._axis.lengthSq() > 1) this._axis.normalize();
    }
    const run = this.keys.has("shift") || this.mobileRun;
    const jump = this.jumpEdge;
    const grab = this.grabEdge;
    this.jumpEdge = false;
    this.grabEdge = false;
    return { moveAxis: this._axis, run, jump, grab };
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

  /**
   * Puntero continuo en NDC para el campo magnético de las partículas. Devuelve
   * `true` si el puntero está activo (mouse sobre el lienzo, o dedo arrastrando)
   * y escribe su posición NDC en `out`.
   */
  readPointer(out: THREE.Vector2): boolean {
    out.copy(this.pointerNdc);
    return this.pointerActive;
  }

  dispose(): void {
    this.actionSubs.clear();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("pointermove", this.onPointerMove);
    this.el.removeEventListener("pointerup", this.onPointerUp);
    this.el.removeEventListener("pointercancel", this.onPointerUp);
    this.el.removeEventListener("pointerleave", this.onPointerLeave);
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("contextmenu", this.preventCtx);
    this.joyBase.remove();
  }
}
