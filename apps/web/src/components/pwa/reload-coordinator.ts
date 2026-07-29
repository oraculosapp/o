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
 * una recarga EN VUELO a la vez, y una sola maquinaria de aplazamiento comparte
 * el guardarraíl y el listener de visibilidad.
 *
 * === GUARDARRAÍL (qué NUNCA se interrumpe con una recarga silenciosa) ===
 * Recargar por sorpresa a alguien que está EN MEDIO de algo es el peor bug de
 * esta familia. Se aplaza si:
 *   · la pestaña está en background (se hará al volver: recargar sin verlo es
 *     tirar el estado a la basura sin que el usuario entienda por qué);
 *   · hay una partida de ¡Dale a Paqo! en curso (`__PAQO__.game.phase`);
 *   · el foco está en un campo de texto DEL CHAT (perderías lo escrito);
 *   · hay una sesión de VOZ activa (una recarga CUELGA la llamada).
 * La píldora manual ("Actualizar") ignora el guardarraíl: si el usuario toca el
 * botón, es su decisión explícita.
 *
 * === SEÑALES OBSERVABLES (por qué se leen así y no importando estado) ===
 * El chat y la voz los posee otro flujo; aquí NO se importa nada suyo, sólo se
 * observa lo que ya pintan en el DOM:
 *   · Chat escribiendo → `document.activeElement` es un input/textarea/
 *     contentEditable DENTRO del dock del chat, que ya se identifica por
 *     `[data-chat-ready]` (atributo anti-flash de ChatDock) o por su
 *     `role="region"` + `aria-label="Chat de la Biósfera …"`.
 *   · Voz activa → hoy NO existe una señal limpia (`useVoiceRoom` no marca el
 *     DOM ni emite eventos). Se leen tres fuentes, por prioridad:
 *       (a) evento de ventana `phy:voice-state` con `detail.active` — CONTRATO
 *           PROPUESTO, implementado SÓLO del lado consumidor. FALTA el emisor:
 *           `useVoiceRoom` debería hacer
 *           `window.dispatchEvent(new CustomEvent("phy:voice-state", { detail: { active: joined } }))`
 *           en cada transición de `joined` (y `active:false` al desmontar).
 *       (b) `document.documentElement[data-voice="on"]` — CONTRATO PROPUESTO,
 *           al estilo del `data-chat-sheet` que ya pinta ChatDock. También falta
 *           el emisor.
 *       (c) HEURÍSTICA que funciona HOY sin tocar nada: el botón "Salir de la
 *           voz" que `VoiceControls` sólo renderiza cuando `joined === true`.
 *           Es texto-dependiente (frágil ante un cambio de copy), por eso es el
 *           último recurso y por eso se proponen (a)/(b).
 *     Si (a) llega, MANDA: un emisor que dice "off" gana a la heurística.
 *
 * === REINTENTO (el `armed` ya no es de un solo uso) ===
 * Antes `armed` se ponía a `true` justo antes de `location.reload()` y ahí moría
 * el asunto: si la recarga NO llegaba a ocurrir (un `beforeunload` cancelado, un
 * navegador que la ignora en background, una PWA iOS suspendida a medio camino),
 * la página se quedaba armada PARA SIEMPRE y no se reintentaba jamás. Ahora tras
 * pedir la recarga se arma un WATCHDOG: si seguimos vivos pasados unos segundos,
 * la recarga se dio por bloqueada, se DESARMA y vuelve a la cola de aplazados.
 * La cola reintenta con backoff 15s → 30s → 60s (tope 60s, sin martillear) y
 * además re-evalúa al instante en `visibilitychange`. Sin tope de intentos a
 * propósito: el objetivo del arreglo es que NUNCA se quede permanentemente
 * atascado; cada intento son dos lecturas de DOM, es barato.
 *
 * La lógica de decisión pura (`shouldReloadNow`, `deferReason`, `isGameRunningIn`,
 * `isChatComposerFocusedIn`, `isVoiceActiveIn`) vive sin DOM real —recibe objetos
 * pato-tipados— para poder testearla en el entorno `node` de vitest.
 */

/** Contexto mínimo para decidir si es seguro recargar AHORA. */
export interface ReloadContext {
  /** ¿La pestaña está visible? (no recargar en background: se hará al volver). */
  visible: boolean;
  /** ¿Hay una partida de ¡Dale a Paqo! en curso? (no interrumpirla). */
  gameRunning: boolean;
  /** ¿El foco está en un campo de texto del chat? (no borrarle lo escrito). */
  chatTyping?: boolean;
  /** ¿Hay sesión de voz activa? (una recarga colgaría la llamada). */
  voiceActive?: boolean;
}

/** Motivo por el que NO se puede recargar ahora (`null` = vía libre). */
export type DeferReason = "hidden" | "game" | "chat" | "voice" | null;

/**
 * ¿Por qué NO se puede recargar ahora? PURA (sin DOM), testeable en node.
 * Devuelve el PRIMER motivo por orden de contundencia (visibilidad primero: si
 * la pestaña está oculta da igual lo demás) o `null` si hay vía libre.
 */
export function deferReason(ctx: ReloadContext): DeferReason {
  if (!ctx.visible) return "hidden"; // esperar a que el usuario vuelva a la pestaña
  if (ctx.gameRunning) return "game"; // no dar el tirón en mitad de una partida
  if (ctx.voiceActive) return "voice"; // recargar cuelga la llamada
  if (ctx.chatTyping) return "chat"; // se perdería lo que está escribiendo
  return null;
}

/**
 * ¿Es seguro recargar en este instante? PURA (sin DOM), testeable en node.
 * Conservadora: sólo `true` cuando no hay ningún motivo de aplazamiento.
 */
export function shouldReloadNow(ctx: ReloadContext): boolean {
  return deferReason(ctx) === null;
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

/**
 * Selectores que identifican la RAÍZ del dock del chat. Dos, por redundancia:
 * el atributo anti-flash que ChatDock ya pinta siempre, y su semántica ARIA.
 * Si un día cambia uno, el otro sigue sujetando el guardarraíl.
 */
const CHAT_ROOT_SELECTORS = ['[data-chat-ready]', '[role="region"][aria-label^="Chat"]'];

/** Elemento mínimo que necesitamos leer del foco (pato-tipado para los tests). */
interface FocusLikeElement {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/**
 * ¿El foco está en el COMPOSER del chat (input/textarea/contentEditable dentro
 * del dock)? PURA respecto al `document` que se le pase. Degrada a `false` ante
 * cualquier ausencia o excepción: un guardarraíl roto nunca debe impedir que la
 * app actualice, sólo puede aplazar cuando está seguro.
 */
export function isChatComposerFocusedIn(doc: unknown): boolean {
  try {
    const d = doc as { activeElement?: FocusLikeElement | null };
    const el = d?.activeElement;
    if (!el) return false;
    const tag = String(el.tagName ?? "").toUpperCase();
    const editable = tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
    if (!editable) return false;
    // Sólo cuenta si ese campo vive DENTRO del chat: escribir en el formulario de
    // perfil o en el registro no es asunto de este guardarraíl (esas pantallas no
    // son el mundo y perder foco ahí no es el bug que arreglamos).
    return CHAT_ROOT_SELECTORS.some((sel) => {
      try {
        return el.closest?.(sel) != null;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Selectores que delatan una sesión de voz VIVA en el DOM. El primero es el
 * contrato propuesto (falta emisor); el segundo es la heurística que funciona
 * hoy: `VoiceControls` sólo pinta "Salir de la voz" cuando `joined === true`.
 */
const VOICE_LIVE_SELECTORS = ['[data-voice="on"]', 'button[aria-label="Salir de la voz"]'];

/**
 * ¿Hay una sesión de voz activa? PURA respecto al global que se le pase.
 *
 * `eventHint` es lo último que dijo el evento `phy:voice-state` (contrato
 * propuesto): si existe MANDA sobre el DOM —el emisor sabe más que nosotros— y
 * `false` explícito significa "ya colgué", no "no sé". `null`/`undefined` =
 * nadie ha hablado nunca → se cae a las señales del DOM.
 */
export function isVoiceActiveIn(globalObj: unknown, eventHint?: boolean | null): boolean {
  if (eventHint === true) return true;
  if (eventHint === false) return false;
  try {
    const g = globalObj as {
      document?: {
        documentElement?: { dataset?: Record<string, string | undefined> } | null;
        querySelector?: (selector: string) => unknown;
      } | null;
    };
    const doc = g?.document;
    if (!doc) return false;
    if (doc.documentElement?.dataset?.voice === "on") return true;
    return VOICE_LIVE_SELECTORS.some((sel) => {
      try {
        return doc.querySelector?.(sel) != null;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parte de runtime (toca DOM). No se ejecuta en SSR ni en los tests puros.
// ---------------------------------------------------------------------------

/** Nombre del evento de estado de voz (contrato propuesto; falta el emisor). */
export const VOICE_STATE_EVENT = "phy:voice-state";

const DEFER_BASE_MS = 15 * 1000; // primer reintento de una recarga aplazada
const DEFER_MAX_MS = 60 * 1000; // tope del backoff: como mucho un chequeo por minuto
/**
 * Margen para dar por BLOQUEADA una recarga ya pedida. `location.reload()` no
 * devuelve nada útil: o la página muere, o no. Si a los 5s seguimos ejecutando
 * JS, no murió → desarmar y reintentar.
 */
const RELOAD_WATCHDOG_MS = 5 * 1000;

let armed = false; // hay una recarga EN VUELO — guarda anti-bucle / anti-doble-camino
let deferred = false; // hay una recarga esperando a que sea seguro
let timer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let attempt = 0; // nº de esperas ya cumplidas: alimenta el backoff
let listening = false;
let voiceListening = false;
let voiceEventHint: boolean | null = null; // último `detail.active` de phy:voice-state

/** Espera antes del próximo intento: 15s → 30s → 60s → 60s… */
function backoffMs(): number {
  return Math.min(DEFER_BASE_MS * 2 ** attempt, DEFER_MAX_MS);
}

/**
 * Consumidor del contrato `phy:voice-state`. Se engancha en cuanto el
 * coordinador entra en juego; mientras nadie lo emita, `voiceEventHint` sigue en
 * `null` y el guardarraíl usa las señales del DOM.
 */
function onVoiceState(e: Event): void {
  const detail = (e as CustomEvent<unknown>).detail;
  if (typeof detail === "boolean") voiceEventHint = detail;
  else if (detail && typeof detail === "object" && "active" in detail) {
    const active = (detail as { active?: unknown }).active;
    if (typeof active === "boolean") voiceEventHint = active;
  }
}

function ensureVoiceListener(): void {
  if (voiceListening || typeof window === "undefined") return;
  window.addEventListener(VOICE_STATE_EVENT, onVoiceState);
  voiceListening = true;
}

/** Lee el contexto real del navegador (no seguro en SSR: comprobar antes). */
function currentContext(): ReloadContext {
  const hasDoc = typeof document !== "undefined";
  return {
    visible: hasDoc && document.visibilityState === "visible",
    gameRunning: typeof window !== "undefined" && isGameRunningIn(window),
    chatTyping: hasDoc && isChatComposerFocusedIn(document),
    voiceActive: typeof window !== "undefined" && isVoiceActiveIn(window, voiceEventHint),
  };
}

function clearTimer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function stopDeferMachinery(): void {
  clearTimer();
  if (listening && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
  }
  listening = false;
  deferred = false;
}

/** Programa el próximo reintento con la espera que toque (backoff). */
function scheduleRetry(): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    attempt += 1; // cada espera cumplida alarga la siguiente (hasta el tope)
    if (!tryReload()) scheduleRetry();
  }, backoffMs());
}

/**
 * La recarga se pidió pero seguimos vivos → la bloqueó algo (un `beforeunload`
 * cancelado, el navegador, la PWA suspendida). Se DESARMA y vuelve a la cola en
 * vez de quedarse atascada para siempre, que era el bug.
 */
function onReloadBlocked(): void {
  watchdog = null;
  if (!armed) return;
  armed = false;
  attempt += 1; // el intento fallido también cuenta para el backoff
  startDeferMachinery();
}

function armWatchdog(): void {
  if (watchdog != null) clearTimeout(watchdog);
  watchdog = setTimeout(onReloadBlocked, RELOAD_WATCHDOG_MS);
}

/** Intenta recargar ya. Devuelve `true` si recargó (o ya estaba armada). */
function tryReload(): boolean {
  if (armed) return true;
  if (!shouldReloadNow(currentContext())) return false;
  armed = true;
  stopDeferMachinery();
  if (typeof window !== "undefined") {
    armWatchdog(); // si la recarga no llega a ocurrir, volvemos a la cola
    window.location.reload();
  }
  return true;
}

function onVisible(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    // Volver a la pestaña es la señal más fuerte que tenemos: se reintenta al
    // instante y, si sigue bloqueado, se reprograma con la espera que tocaba.
    if (!tryReload() && deferred) scheduleRetry();
  }
}

function startDeferMachinery(): void {
  if (deferred || armed) return;
  deferred = true;
  ensureVoiceListener();
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
    listening = true;
  }
  scheduleRetry();
}

/**
 * Punto de entrada COMÚN de recarga silenciosa. Recarga ya si es seguro; si no
 * (background, partida, chat en curso o voz activa), la aplaza y la dispara en
 * cuanto lo sea. Idempotente: llamarla desde los dos caminos no produce dobles
 * recargas.
 */
export function requestReload(): void {
  if (armed) return;
  ensureVoiceListener();
  if (!tryReload()) startDeferMachinery();
}

/**
 * Recarga que el USUARIO pidió explícitamente (píldora "Actualizar"). Respeta el
 * anti-doble-camino pero IGNORA el guardarraíl: si el usuario toca el botón, es
 * su decisión (aunque esté en una partida o en la voz). Cancela cualquier
 * aplazamiento en curso y, si la recarga acabara bloqueada, el watchdog desarma
 * para que un segundo toque en la píldora vuelva a funcionar.
 */
export function forceReload(): void {
  if (armed) return;
  armed = true;
  stopDeferMachinery();
  if (typeof window !== "undefined") {
    armWatchdog();
    window.location.reload();
  }
}

/**
 * ¿Ya se armó una recarga por alguno de los caminos? Sirve para que un camino no
 * duplique trabajo (p. ej. el centinela no muestra la píldora si el SW ya va a
 * recargar).
 */
export function isReloadArmed(): boolean {
  return armed;
}

/** ¿Hay una recarga esperando a que sea seguro? (diagnóstico / tests). */
export function isReloadDeferred(): boolean {
  return deferred;
}

/**
 * SOLO para tests: restablece el estado de módulo. En producción el estado es
 * intencionadamente un singleton que vive toda la sesión de la página.
 */
export function __resetReloadCoordinatorForTests(): void {
  stopDeferMachinery();
  if (watchdog != null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  if (voiceListening && typeof window !== "undefined") {
    window.removeEventListener(VOICE_STATE_EVENT, onVoiceState);
  }
  voiceListening = false;
  voiceEventHint = null;
  attempt = 0;
  armed = false;
}
