/**
 * Contrato UI ⇄ engine para los hooks del MUNDO que consume el HUD (chat, botones
 * móviles). Lo IMPLEMENTA el equipo de engine sobre `PaqoWorld`; aquí sólo lo
 * TIPAMOS y lo accedemos con optional-chaining para degradar con gracia mientras
 * aún no exista (todos los métodos son opcionales a propósito).
 *
 *   · setViewportInset({right}) — recentra el juego cuando el chat es columna.
 *   · setInputEnabled(bool)     — apaga el input del juego cuando el chat tiene foco.
 *   · input.pressJump()/pressGrab() + onActionState(cb) — botones táctiles.
 *
 * La app obtiene el mundo por un getter perezoso (`() => worldRef.current`) porque
 * el engine adjunta estos métodos tras `start()`.
 */

/** Márgenes (px) que el juego debe respetar para centrar el avatar en el área visible. */
export interface ViewportInset {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Estado de acción del personaje para los botones táctiles del HUD. */
export interface WorldActionState {
  /** Hay algo agarrable al alcance. */
  canGrab: boolean;
  /** El personaje sostiene un objeto (el botón pasa a "Lanzar"). */
  holding: boolean;
  /** Pegado al suelo. */
  grounded: boolean;
  /** Puede encadenar un segundo salto (doble salto). */
  canDoubleJump: boolean;
  /** En modo VUELO (triple salto): el botón de salto pasa a "Caer". */
  flying: boolean;
}

/** Sub-API de input del mundo para botones móviles. */
export interface WorldInputHooks {
  pressJump?(): void;
  pressGrab?(): void;
  /** Botón VOLAR móvil / tecla Q: alterna el modo VUELO del personaje. */
  pressFly?(): void;
  /** Botón CORRER móvil en HOLD (mantener = correr). */
  setRun?(on: boolean): void;
  /** Botón CORRER móvil en TOGGLE (alterna correr/caminar). */
  pressRun?(): void;
  /** Suscribe cambios de estado de acción; devuelve una función para desuscribir. */
  onActionState?(cb: (s: WorldActionState) => void): () => void;
}

/**
 * Espejo ESTRUCTURAL de `GameSnapshot` del engine (packages/engine/game/BallGame).
 * Se duplica aquí — igual que WorldNetHooks en lib/realtime.ts — para no acoplar
 * la app al paquete del engine en tiempo de tipos; el compilador comprueba que
 * ambas formas coinciden por estructura.
 */
export interface GameSnapshotUi {
  phase: "idle" | "running" | "results";
  endsAt: number;
  scores: Record<string, number>;
  startedBy: string;
  winnerIds: string[];
  /** playerId → nombre visible (roster + eventos). Para pintar el marcador. */
  names: Record<string, string>;
  /** Id del jugador LOCAL (para resaltar "tú"). */
  localId: string;
}

/** Espejo ESTRUCTURAL de `GameEvent` del engine (unión difundida por el canal). */
export type GameEventUi =
  | { type: "start"; by: string; endsAt: number }
  | { type: "stop"; by: string }
  | { type: "hit"; by: string; ballId: number; hitPos: [number, number, number] }
  | { type: "state"; endsAt: number; scores: Record<string, number>; startedBy: string };

/** Sub-API del mini-juego ¡Dale a Paqo! que consume el HUD (equipo Juego). */
export interface WorldGameHooks {
  setLocalPlayer?(id: string): void;
  /** Fusiona nombres visibles (roster de presencia + eventos) en el marcador. */
  mergeNames?(names: Record<string, string>): void;
  start?(): void;
  stop?(): void;
  applyRemote?(e: GameEventUi): void;
  /** Suscribe eventos locales del juego (para que la red los propague). Unsub fn. */
  onLocalEvent?(cb: (e: GameEventUi) => void): () => void;
  /** Suscribe cambios de snapshot (para el HUD). Unsub fn. */
  onChange?(cb: (s: GameSnapshotUi) => void): () => void;
  snapshot?(): GameSnapshotUi;
}

/**
 * Espejo ESTRUCTURAL mínimo del `controller` del engine (CharacterController).
 * Sólo exponemos LO QUE EL HUD lee: la posición del jugador (Vector3 → {x,y,z}).
 * Se accede con optional-chaining sobre el getter perezoso; PaqoWorld lo publica
 * tras `start()`. No acopla la app al paquete del engine (igual criterio que el
 * resto de este contrato).
 */
export interface WorldControllerUi {
  /** Posición mundial del avatar local (metros). El HUD la sondea para el gating. */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/** Superficie del mundo que consume el HUD (todo opcional → degradación elegante). */
export interface WorldUiHooks {
  setViewportInset?(inset: ViewportInset): void;
  setInputEnabled?(enabled: boolean): void;
  input?: WorldInputHooks;
  /** Aplica un "mood" de color grading (equipo Atmos). */
  setMood?(id: string): void;
  /** Cambia el clima de la biósfera (equipo Atmos). */
  setWeather?(id: string): void;
  /** Sub-API del mini-juego (equipo Juego). */
  game?: WorldGameHooks;
  /** Controlador del personaje (posición del jugador). Sólo lectura para el HUD. */
  controller?: WorldControllerUi;
  // ---- DIBUJAR (equipo Vuelo/Mandos): toggle del modo dibujo ----
  /** Activa/desactiva el modo DIBUJAR (estela arcoíris persistente). */
  setDrawing?(on: boolean): void;
  /** ¿El modo DIBUJAR está activo? (para el estado visual del botón). */
  isDrawing?(): boolean;
}

/** Getter perezoso del mundo (puede devolver null si aún no montó). */
export type GetWorld = () => WorldUiHooks | null | undefined;
