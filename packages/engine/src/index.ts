// Escena jugable de la Biósfera Paqo (planeta + controller + cámara + input).
export { PaqoWorld } from "./PaqoWorld";
export { Planet } from "./planet/Planet";
export { PlanetField } from "./planet/PlanetField";
export { CharacterController } from "./controller/CharacterController";
export { FollowCamera } from "./camera/FollowCamera";
export { InputManager } from "./input/InputManager";
export type { BiospherePreset } from "./planet/types";

// "Hola planeta" original (se conserva para referencia / fallback).
export { HolaPlaneta } from "./HolaPlaneta";
export type { PlanetPreset } from "./HolaPlaneta";
export { SimplexNoise } from "./noise";
