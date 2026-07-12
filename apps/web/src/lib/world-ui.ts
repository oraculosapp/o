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
}

/** Sub-API de input del mundo para botones móviles. */
export interface WorldInputHooks {
  pressJump?(): void;
  pressGrab?(): void;
  /** Suscribe cambios de estado de acción; devuelve una función para desuscribir. */
  onActionState?(cb: (s: WorldActionState) => void): () => void;
}

/** Superficie del mundo que consume el HUD (todo opcional → degradación elegante). */
export interface WorldUiHooks {
  setViewportInset?(inset: ViewportInset): void;
  setInputEnabled?(enabled: boolean): void;
  input?: WorldInputHooks;
}

/** Getter perezoso del mundo (puede devolver null si aún no montó). */
export type GetWorld = () => WorldUiHooks | null | undefined;
