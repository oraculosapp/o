/**
 * Audio procedural de Phygitalia (100% WebAudio, cero archivos). Síntesis en
 * tiempo real: la tesis telúrico-SINTÉTICA hecha sonido.
 *
 *  - {@link Soundscape}: orquestador cara al mundo (lo instancia PaqoWorld).
 *  - {@link SoundscapeEngine}: motor WebAudio (contexto, master, limiter, mute).
 *  - {@link AmbientBed} / {@link Foley}: capas (cama generativa / foley).
 *  - {@link uiSound}: API de blips de UI para el HUD (singleton).
 *  - {@link muteStore}: estado de mute persistido/compartido con el HUD.
 */
export { Soundscape } from "./Soundscape";
export { SoundscapeEngine, type NoiseField } from "./SoundscapeEngine";
export { AmbientBed, pickPadChord, pickPadNote, PAD_SCALE } from "./AmbientBed";
export { Foley } from "./Foley";
export { uiSound, type UiSoundKind, type UiBlips } from "./UiBlips";
export { createNoiseBuffer, type NoiseColor } from "./noise";
export { kickStrengthFromVel, MIN_AUDIBLE_KICK_SPEED } from "./kickSound";
export {
  AUDIO_MUTE_KEY,
  getAudioMuted,
  setAudioMuted,
  subscribeAudioMuted,
} from "./muteStore";
