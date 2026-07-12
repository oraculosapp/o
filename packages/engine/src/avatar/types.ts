import type * as THREE from "three";

/**
 * Contrato común de avatares de Phygitalia.
 *
 * Lo implementan tanto {@link AvatarRig} (carga un GLB skinned de Tripo3D) como
 * {@link TestDummy} (maniquí procedural en código). El `CharacterController`
 * adoptará una instancia de `IAvatarRig` en lugar de su cápsula placeholder en
 * el siguiente paso de integración — sin que este módulo tenga que tocar el
 * controller.
 *
 * Punto de integración esperado (lo hará el orquestador, no este equipo):
 *   1. El controller instancia el rig (dummy hoy, AvatarRig cuando lleguen los GLB).
 *   2. Añade `rig.root` a la escena en lugar de su cápsula.
 *   3. Usa `rig.height` para recalcular `eyeHeight` (centro = height/2 sobre el suelo).
 *   4. Cada frame llama `rig.update(dt, state)` con velocidad/estado del controller.
 */
export interface IAvatarRig {
  /** Objeto raíz a añadir a la escena (reemplaza la cápsula del controller). */
  readonly root: THREE.Object3D;
  /** Altura real del modelo en unidades de mundo (para colocar/escalar en el controller). */
  readonly height: number;
  /** Avanza mixer de animación y elige/mezcla clips según el estado de conducción. */
  update(dt: number, state: AvatarDriveState): void;
  /** Recolorea por zonas (la capa "híbrida" de personalización). */
  setTint(palette: Partial<Record<TintZone, THREE.Color>>): void;
  /** Engancha un prop (regadera, catalejo, cayado...) a un socket que sigue la animación. */
  attachProp(mesh: THREE.Object3D, socket: PropSocket): void;
  /** Libera geometrías, materiales y clips. */
  dispose(): void;
}

/** Estado de conducción que el controller pasa cada frame para elegir la animación. */
export interface AvatarDriveState {
  /** Rapidez horizontal actual (u/s). */
  speed: number;
  /** Rapidez horizontal máxima posible (u/s) — para normalizar idle/walk/run. */
  maxSpeed: number;
  /** ¿Pegado al suelo? */
  grounded: boolean;
  /** ¿En fase de salto/aéreo? */
  jumping: boolean;
}

/** Zonas de color personalizables. `primary` = ropa principal, `secondary` = ropa secundaria. */
export type TintZone = "primary" | "secondary" | "hair";

/** Sockets donde se pueden enganchar props icónicos. */
export type PropSocket = "handR" | "handL" | "back";

/**
 * Configuración de avatar que la app pasa al mundo (selector de arquetipo →
 * PaqoWorld). Todos los campos son opcionales para degradar con gracia:
 *
 *   · sin `archetypeUrl`  → el mundo usa el maniquí procedural (TestDummy).
 *   · con `archetypeUrl`  → intenta cargar el GLB riggeado; si falla (404 porque
 *     el modelo "aún duerme"), se queda en el maniquí y avisa por `onArchetypeMissing`.
 *   · `tint` se aplica SIEMPRE (dummy o arquetipo): es la capa híbrida de color.
 *
 * Los colores van como hex `#rrggbb` para que la config sea serializable
 * (localStorage / jsonb del perfil) sin depender de THREE.
 */
export interface AvatarConfig {
  /** URL del GLB del arquetipo (p.ej. `/assets/avatars/hacker-m.glb`). */
  archetypeUrl?: string;
  /** Tinte por zona (hex). Blanco/omitido = sin cambio. */
  tint?: Partial<Record<TintZone, string>>;
  /** Se llama si el GLB del arquetipo no se pudo cargar (fallback a dummy). */
  onArchetypeMissing?: (url: string) => void;
  /** Se llama cuando el arquetipo cargó y sustituyó al maniquí. */
  onArchetypeLoaded?: (url: string) => void;
}
