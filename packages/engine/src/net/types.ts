import type * as THREE from "three";

/**
 * Contrato de red del mundo (equipo Engine-Net, S3b).
 *
 * Este módulo NO habla con ninguna red: expone los *hooks* que el equipo de red
 * (apps/web) programará por encima. El motor rellena avatares remotos, las 9
 * pelotas físicas y las señales de zona; la red sólo inyecta/lee estado a través
 * de esta interfaz. Sin red, todo funciona 100% local (las pelotas ruedan, las
 * zonas se emiten, `getLocalState` reporta al jugador).
 *
 * Disponible como `world.net` tras `PaqoWorld.start()`.
 */
export interface WorldNetHooks {
  /** Estado del jugador local (para que la red lo difunda). pos = centro del avatar. */
  getLocalState(): LocalState;
  /**
   * Suscribe un callback que recibe el estado local a `hz` Hz (default 10).
   * Devuelve la función para desuscribir.
   */
  onLocalTick(cb: (s: LocalState) => void, hz?: number): () => void;
  /** Crea o actualiza un avatar remoto por `id` (pool con cap 32, interpolado). */
  upsertRemote(id: string, s: RemoteState): void;
  /** Retira un avatar remoto (fade + partícula suave, luego se libera). */
  removeRemote(id: string): void;
  /** Suscribe patadas locales de pelota (para que la red las propague). Unsub fn. */
  onBallKick(cb: (ballId: number, s: BallState) => void): () => void;
  /** Aplica estado de pelota recibido de la red (reconciliación suave, no teleport). */
  applyBallState(ballId: number, s: BallState): void;
  /** Suscribe cambios de zona respecto al tótem. Unsub fn. */
  onZoneSignal(cb: (signal: ZoneSignal) => void): () => void;
}

/** Terna posicional en espacio mundo. */
export type Vec3 = [number, number, number];

/** Animación de locomoción sincronizable. */
export type NetAnim = "idle" | "walk" | "run" | "jump";

/** Estado del jugador local que consume la red. */
export interface LocalState {
  pos: Vec3;
  yaw: number;
  anim: NetAnim;
}

/** Estado de un avatar remoto que inyecta la red. */
export interface RemoteState {
  pos: Vec3;
  yaw: number;
  /** Animación ("idle"|"walk"|"run"|"jump"); tolerante a otros strings → idle. */
  anim: string;
  /** Color primario del rig (hex "#rrggbb"). */
  tint?: string;
  /** Etiqueta flotante sobre la cabeza. */
  name?: string;
  /**
   * ID del arquetipo del remoto (p.ej. `vampiro`). Si es uno de los 9
   * PROCEDURALES, el remoto se construye con `buildArchetype` (100% código,
   * instantáneo, sin fetch). Como fallback (uso futuro) admite una URL de GLB
   * same-origin bajo `/assets/avatars/`; si falta o falla, se queda con el maniquí.
   */
  archetype?: string;
}

/** Estado dinámico de una pelota (posición + velocidad en mundo). */
export interface BallState {
  pos: Vec3;
  vel: Vec3;
}

/** Señal de proximidad al tótem. */
export type ZoneSignal = "far" | "mid" | "near" | "found";

/** Dependencias que el orquestador de red toma del mundo. */
export interface WorldNetDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Posición actual (centro) del jugador; se lee cada frame. */
  playerPosition: THREE.Vector3;
  /** Frente del jugador (se lee cada frame para el yaw local). */
  playerForward: (out?: THREE.Vector3) => THREE.Vector3;
  /** ¿El jugador está en el suelo? (para elegir idle/walk/run vs jump). */
  playerGrounded: () => boolean;
  /**
   * Altura Y de los PIES del jugador (pivote − eyeHeight). La usa el contacto
   * de patada de las pelotas (ventana vertical de piernas). Opcional:
   * sin ella se estima como pos.y − 0.9.
   */
  playerFeetY?: () => number;
  /** Campo de altura de la isla (ancla la física de pelotas). */
  field: FieldLike;
}

/** Subconjunto de IslandField que necesita la física de pelotas y las zonas. */
export interface FieldLike {
  heightAt(x: number, z: number): number;
  surfaceNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  insideIsland(x: number, z: number): boolean;
}
