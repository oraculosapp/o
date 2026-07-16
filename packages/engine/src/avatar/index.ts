// Módulo de avatares Phygitalia (S2 — equipo Avatares).
export { AvatarRig, type AvatarRigOptions, type AvatarSource } from "./AvatarRig";
export { loadAvatarRigShared, clearAvatarGLTFCache } from "./AvatarGLTFCache";
export { TestDummy } from "./TestDummy";
export { AnimationDriver, type Locomotion } from "./AnimationDriver";
export { ProceduralLocomotion, type LocomotionQA } from "./ProceduralLocomotion";
export { ExpressiveEyes, type EyeState } from "./ExpressiveEyes";
export { TintController, toToonMaterial, avatarToonRamp, type HueBand } from "./tint";
export type { IAvatarRig, AvatarDriveState, TintZone, PropSocket, AvatarConfig } from "./types";
