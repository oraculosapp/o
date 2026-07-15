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
  /**
   * Suscribe AGARRES locales de pelota (primero o robo) para difundir "ball_grab".
   * El callback recibe `(ballId, t)` con `t=Date.now()`. Unsub fn.
   */
  onBallGrab(cb: (ballId: number, t: number) => void): () => void;
  /**
   * Aplica un AGARRE remoto ("ball_grab"): si el jugador local llevaba ese balón y
   * el agarre ajeno gana el desempate (t más nuevo; empate → id menor), lo suelta en
   * silencio (robo). Si no lo llevaba, no hace nada (lo sigue el flujo "ball").
   */
  applyBallGrab(ballId: number, by: string, t: number): void;
  /** Fija el id del jugador local (para desempatar robos por id lexicográfico). */
  setLocalId(id: string): void;
  /** Suscribe cambios de zona respecto al tótem. Unsub fn. */
  onZoneSignal(cb: (signal: ZoneSignal) => void): () => void;
  // ---- DIBUJAR (equipo Vuelo/Mandos): difusión de trazos por la red ----
  /** Suscribe LOTES locales de dibujo (para que la red los difunda "draw"). Unsub fn. */
  onDrawBatch(cb: (b: DrawBatch) => void): () => void;
  /** Aplica un lote de dibujo de un trazo REMOTO (mismo sistema de pintado). */
  applyDrawBatch(by: string, b: DrawBatch): void;
  // ---- EMOTES (equipo Avatar): difusión de emotes sobre el propio avatar ----
  /**
   * Suscribe EMOTES locales (el jugador dispara un emote sobre su propio avatar)
   * para que la red los difunda ("emote" broadcast). Unsub fn. `emote` = emote id.
   */
  onLocalEmote(cb: (emote: string) => void): () => void;
  /** Notifica un emote local a los suscriptores (lo llama la UI al elegir emote). */
  emitLocalEmote(emote: string): void;
  /** Aplica un EMOTE remoto: el avatar del remoto `id` reproduce `emote`. */
  applyRemoteEmote(id: string, emote: string): void;
}

/** Terna posicional en espacio mundo. */
export type Vec3 = [number, number, number];

/**
 * Animación de locomoción sincronizable. "fly" es el modo VUELO (triple salto);
 * los clientes que no lo conozcan caen a idle (RemotePlayers tolera strings).
 */
export type NetAnim = "idle" | "walk" | "run" | "jump" | "fly";

/**
 * Un lote de puntos de un TRAZO de dibujo para difundir/aplicar (equipo Vuelo).
 * `stroke` = id del trazo del emisor; `points` = plano [x,y,z, …] (≤40 puntos).
 * Espejo de {@link import("../world/DrawTrail").DrawBatch}.
 */
export interface DrawBatch {
  stroke: number;
  points: number[];
}

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
  /** ¿El jugador está VOLANDO? (triple salto) — clasifica la anim de red como "fly". */
  playerFlying?: () => boolean;
  /**
   * Altura Y de los PIES del jugador (pivote − eyeHeight). La usa el contacto
   * de patada de las pelotas (ventana vertical de piernas). Opcional:
   * sin ella se estima como pos.y − 0.9.
   */
  playerFeetY?: () => number;
  /** Campo de altura de la isla (ancla la física de pelotas). */
  field: FieldLike;
  /**
   * Estela de partículas COMPARTIDA (equipo Vuelo): RemotePlayers emite motas
   * desde los pies de cada remoto en el MISMO pool que el jugador local (1 draw
   * call). Opcional: sin ella, los remotos simplemente no dejan estela.
   */
  motionTrail?: MotionEmitter;
}

/** Emisor de estela de partículas (subconjunto de MotionTrail que usa la red). */
export interface MotionEmitter {
  /** Emite UNA mota en (x,y,z) — típicamente los pies del emisor. */
  emit(x: number, y: number, z: number): void;
}

/** Subconjunto de IslandField que necesita la física de pelotas y las zonas. */
export interface FieldLike {
  heightAt(x: number, z: number): number;
  surfaceNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  insideIsland(x: number, z: number): boolean;
  /** Nivel base de referencia del claro (para el umbral de caída al vacío). */
  readonly clearLevel: number;
}

/** Eventos del mini-juego ¡Dale a Paqo! difundidos por el canal de la biósfera. */
export type GameEvent =
  | { type: "start"; by: string; endsAt: number }
  | { type: "stop"; by: string }
  | { type: "hit"; by: string; ballId: number; hitPos: [number, number, number] }
  | { type: "state"; endsAt: number; scores: Record<string, number>; startedBy: string };
