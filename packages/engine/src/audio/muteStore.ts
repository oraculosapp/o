/**
 * Estado de silencio del soundscape, PERSISTIDO y COMPARTIDO entre el motor de
 * audio (packages/engine) y el HUD (apps/web) sin acoplarlos.
 *
 * Canal: `localStorage` (persistencia entre recargas) + un `CustomEvent` en
 * `window` (sincronía en vivo dentro de la misma pestaña) + el evento nativo
 * `storage` (sincronía entre pestañas). El botón mute del HUD escribe con
 * {@link setAudioMuted}; el {@link SoundscapeEngine} escucha con
 * {@link subscribeAudioMuted}. Nadie necesita una referencia al otro.
 *
 * Por defecto el mundo SUENA (unmuted): silencio sólo si el usuario lo eligió.
 */

/** Clave de localStorage del estado de mute. */
export const AUDIO_MUTE_KEY = "phygitalia.audio.muted";
/** Nombre del CustomEvent in-page de cambio de mute. */
const AUDIO_MUTE_EVENT = "phygitalia:audio-muted";

/** ¿Está el audio silenciado? (default: no). SSR-safe. */
export function getAudioMuted(): boolean {
  try {
    return localStorage.getItem(AUDIO_MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Fija el estado de mute: persiste y notifica a los suscriptores de esta pestaña. */
export function setAudioMuted(muted: boolean): void {
  try {
    localStorage.setItem(AUDIO_MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* modo privado / SSR: seguimos emitiendo el evento en vivo */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUDIO_MUTE_EVENT, { detail: muted }));
  }
}

/**
 * Suscribe cambios de mute (in-page vía CustomEvent y entre pestañas vía
 * `storage`). Devuelve la función para desuscribir.
 */
export function subscribeAudioMuted(cb: (muted: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onEvt = (e: Event): void => cb(Boolean((e as CustomEvent<boolean>).detail));
  const onStorage = (e: StorageEvent): void => {
    if (e.key === AUDIO_MUTE_KEY) cb(e.newValue === "1");
  };
  window.addEventListener(AUDIO_MUTE_EVENT, onEvt);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AUDIO_MUTE_EVENT, onEvt);
    window.removeEventListener("storage", onStorage);
  };
}
