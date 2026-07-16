/**
 * Coordinador ÚNICO de recargas de la PWA.
 *
 * Hay DOS caminos independientes que pueden querer recargar la página para
 * salir de una build vieja:
 *
 *   1. El beacon de versión (`UpdateSentinel`): compara el build id embebido con
 *      el que sirve `/api/version`. Es la señal PRINCIPAL en background.
 *   2. El Service Worker (`ServiceWorkerRegister`): cuando un SW nuevo toma el
 *      control (`controllerchange`) hay que recargar para correr el shell nuevo.
 *      Es la RED DE SEGURIDAD cuando lo que cambia es el propio SW.
 *
 * Si ambos recargaran por su cuenta tendríamos dobles recargas y bucles. Por eso
 * los dos convergen aquí: un único flag de módulo (`armed`) garantiza COMO MUCHO
 * una recarga por vida de página, y una sola maquinaria de aplazamiento comparte
 * el guardarraíl de partida y el listener de visibilidad.
 *
 * La lógica de decisión pura (`shouldReloadNow`, `isGameRunningIn`) vive sin DOM
 * para poder testearla en el entorno `node` de vitest.
 */

/** Contexto mínimo para decidir si es seguro recargar AHORA. */
export interface ReloadContext {
  /** ¿La pestaña está visible? (no recargar en background: se hará al volver). */
  visible: boolean;
  /** ¿Hay una partida de ¡Dale a Paqo! en curso? (no interrumpirla). */
  gameRunning: boolean;
}

/**
 * ¿Es seguro recargar en este instante? PURA (sin DOM), testeable en node.
 * Conservadora: solo `true` con pestaña visible y sin partida activa.
 */
export function shouldReloadNow(ctx: ReloadContext): boolean {
  if (!ctx.visible) return false; // esperar a que el usuario vuelva a la pestaña
  if (ctx.gameRunning) return false; // no dar el tirón en mitad de una partida
  return true;
}

/**
 * ¿Hay una partida en curso, según el global que expone el equipo Juego?
 * PURA respecto al `window` que se le pase: recibe el objeto global y lee
 * `__PAQO__.game.snapshot().phase === "running"`, degradando a `false` ante
 * cualquier ausencia o excepción. Testeable con objetos falsos.
 */
export function isGameRunningIn(globalObj: unknown): boolean {
  try {
    const g = globalObj as {
      __PAQO__?: { game?: { snapshot?: () => { phase?: string } } };
    };
    return g?.__PAQO__?.game?.snapshot?.().phase === "running";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parte de runtime (toca DOM). No se ejecuta en SSR ni en los tests puros.
// ---------------------------------------------------------------------------

const DEFER_POLL_MS = 15 * 1000; // reintento de una recarga aplazada

let armed = false; // ya se disparó (o está garantizada) una recarga — guarda anti-bucle
let deferred = false; // hay una recarga esperando a que sea seguro
let poll: ReturnType<typeof setInterval> | null = null;
let listening = false;

/** Lee el contexto real del navegador (no seguro en SSR: comprobar antes). */
function currentContext(): ReloadContext {
  const visible = typeof document !== "undefined" && document.visibilityState === "visible";
  const gameRunning = typeof window !== "undefined" && isGameRunningIn(window);
  return { visible, gameRunning };
}

function stopDeferMachinery(): void {
  if (poll != null) {
    clearInterval(poll);
    poll = null;
  }
  if (listening && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
  }
  listening = false;
  deferred = false;
}

/** Intenta recargar ya. Devuelve `true` si recargó (o ya estaba armada). */
function tryReload(): boolean {
  if (armed) return true;
  if (!shouldReloadNow(currentContext())) return false;
  armed = true;
  stopDeferMachinery();
  if (typeof window !== "undefined") window.location.reload();
  return true;
}

function onVisible(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    tryReload();
  }
}

function startDeferMachinery(): void {
  if (deferred || armed) return;
  deferred = true;
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
    listening = true;
  }
  if (poll == null) poll = setInterval(tryReload, DEFER_POLL_MS);
}

/**
 * Punto de entrada COMÚN de recarga silenciosa. Recarga ya si es seguro; si no
 * (background o partida en curso), la aplaza y la dispara en cuanto lo sea
 * (al volver a la pestaña o cuando termine la partida). Idempotente: llamarla
 * desde los dos caminos no produce dobles recargas.
 */
export function requestReload(): void {
  if (armed) return;
  if (!tryReload()) startDeferMachinery();
}

/**
 * Recarga que el USUARIO pidió explícitamente (píldora "Actualizar"). Respeta el
 * anti-bucle pero IGNORA el guardarraíl de partida: si el usuario toca el botón,
 * es su decisión. Cancela cualquier aplazamiento en curso.
 */
export function forceReload(): void {
  if (armed) return;
  armed = true;
  stopDeferMachinery();
  if (typeof window !== "undefined") window.location.reload();
}

/**
 * ¿Ya se armó una recarga por alguno de los caminos? Sirve para que un camino no
 * duplique trabajo (p. ej. el centinela no muestra la píldora si el SW ya va a
 * recargar).
 */
export function isReloadArmed(): boolean {
  return armed;
}

/**
 * SOLO para tests: restablece el estado de módulo. En producción el estado es
 * intencionadamente un singleton que vive toda la sesión de la página.
 */
export function __resetReloadCoordinatorForTests(): void {
  stopDeferMachinery();
  armed = false;
}
