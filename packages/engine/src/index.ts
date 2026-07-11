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
export { AvatarRig, type AvatarRigOptions } from "./avatar/AvatarRig";
export { TestDummy } from "./avatar/TestDummy";
export { AnimationDriver, type Locomotion } from "./avatar/AnimationDriver";
export { TintController, toToonMaterial, avatarToonRamp, type HueBand } from "./avatar/tint";
export type { IAvatarRig, AvatarDriveState, TintZone, PropSocket } from "./avatar/types";
