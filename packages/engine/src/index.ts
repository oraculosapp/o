// Escena jugable de la Biósfera Paqo (isla flotante + controller + cámara + input).
export { PaqoWorld } from "./PaqoWorld";
export { Island } from "./island/Island";
export { IslandField } from "./island/IslandField";
export { CharacterController } from "./controller/CharacterController";
export { FollowCamera } from "./camera/FollowCamera";
export { InputManager } from "./input/InputManager";
export type { BiospherePreset } from "./planet/types";

// "Hola planeta" original (se conserva para referencia / fallback).
export { HolaPlaneta } from "./HolaPlaneta";
export type { PlanetPreset } from "./HolaPlaneta";
export { SimplexNoise } from "./noise";

// --- Avatares (equipo Avatares S2) ---
export { AvatarRig, type AvatarRigOptions, type AvatarSource } from "./avatar/AvatarRig";
export { loadAvatarRigShared, clearAvatarGLTFCache } from "./avatar/AvatarGLTFCache";
export { TestDummy } from "./avatar/TestDummy";
export { AnimationDriver, type Locomotion } from "./avatar/AnimationDriver";
export { TintController, toToonMaterial, avatarToonRamp, type HueBand } from "./avatar/tint";
export type { IAvatarRig, AvatarDriveState, TintZone, PropSocket, AvatarConfig } from "./avatar/types";

// --- Audio procedural (equipo Audio S4): WebAudio 100% sintético, cero archivos ---
export { Soundscape } from "./audio/Soundscape";
export { SoundscapeEngine } from "./audio/SoundscapeEngine";
export { AmbientBed } from "./audio/AmbientBed";
export { Foley } from "./audio/Foley";
export { uiSound, type UiSoundKind } from "./audio/UiBlips";
export {
  AUDIO_MUTE_KEY,
  getAudioMuted,
  setAudioMuted,
  subscribeAudioMuted,
} from "./audio/muteStore";

// --- Multijugador: hooks del mundo (equipo Engine-Net S3b) ---
export { WorldNet } from "./net/WorldNet";
export { RemotePlayers } from "./net/RemotePlayers";
export { Balls } from "./net/Balls";
export { ZoneSignals } from "./net/ZoneSignals";
export type {
  WorldNetHooks,
  WorldNetDeps,
  FieldLike,
  LocalState,
  RemoteState,
  BallState,
  ZoneSignal,
  NetAnim,
  Vec3,
} from "./net/types";
