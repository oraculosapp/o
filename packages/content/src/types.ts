/**
 * Tipado del preset de Biósfera Phygitalia.
 *
 * Traduce el esquema de parámetros del generador procedural descrito en
 * `D:\Oraculos\o\docs\investigacion\04-arte-biosferas-avatares.md` §2.
 * `packages/content/biospheres/paqo.json` es la primera instancia concreta;
 * los tipos aquí cubren el JSON completo, no sólo el subconjunto que ya
 * consume `@phygitalia/engine` (ver `PlanetPreset` en HolaPlaneta.ts).
 *
 * Convención para campos cuyo doc no cierra un enum exhaustivo (p.ej. tipos
 * de árbol, cuerpos de agua, props): unión literal de los valores ya vistos
 * en las 10 fichas + escape hatch `(string & {})` para no bloquear presets
 * futuros mientras se sigue teniendo autocompletado de los valores conocidos.
 */

/** Color hexadecimal, p.ej. "#3B4A3F". No se valida el formato en tipos. */
export type HexColor = string;

// ---------------------------------------------------------------------------
// Terreno
// ---------------------------------------------------------------------------

/** §2: plains|valley|dunes|peaks|forestFloor|cave|market|riverbed */
export type TerrainType =
  | "plains"
  | "valley"
  | "dunes"
  | "peaks"
  | "forestFloor"
  | "cave"
  | "market"
  | "riverbed";

/** Kind de ruido de altura. "perlin" es el único valor documentado en Paqo; el
 * motor usa Simplex/fBm internamente (ver packages/engine/src/noise.ts). */
export type NoiseKind = "perlin" | "simplex" | "worley" | "ridged" | (string & {});

export interface TerrainHeightNoise {
  kind: NoiseKind;
  amplitude: number;
  frequency: number;
  octaves: number;
}

export interface TerrainRidges {
  enabled: boolean;
  steepness: number;
}

/** Claro central = punto de encuentro del plan maestro. */
export interface TerrainCentralClearing {
  enabled: boolean;
  radius: number;
  flatness: number;
}

export interface TerrainRockScatter {
  density: number;
  mossy: boolean;
  lowPolyFacets: number;
}

export interface Terrain {
  type: TerrainType;
  heightNoise: TerrainHeightNoise;
  ridges: TerrainRidges;
  centralClearing: TerrainCentralClearing;
  rockScatter: TerrainRockScatter;
}

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------

export interface Palette {
  primary: HexColor;
  secondary: HexColor;
  accent: HexColor;
  ground: HexColor;
  sky: HexColor;
}

// ---------------------------------------------------------------------------
// Vegetación
// ---------------------------------------------------------------------------

/** §2: bromeliads|mushroomsGlow|cropStalls|epiphytes|cablesVines (+ "none") */
export type VegetationSpecialType =
  | "none"
  | "bromeliads"
  | "mushroomsGlow"
  | "cropStalls"
  | "epiphytes"
  | "cablesVines";

/** Tipos de árbol vistos en las fichas (Paqo: gnarled; otras: troncos esbeltos, dosel...). */
export type TreeType = "gnarled" | "birch" | "canopy" | (string & {});

export type ShrubType = "fern" | (string & {});

export interface VegetationGrass {
  density: number;
  height: number;
  windSway: number;
}

export interface VegetationTrees {
  type: TreeType;
  density: number;
  mossHang: boolean;
  clusterAtEdges: boolean;
}

export interface VegetationShrubs {
  type: ShrubType;
  density: number;
}

export interface VegetationFlowers {
  density: number;
  colors: HexColor[];
}

export interface VegetationSpecial {
  type: VegetationSpecialType;
  density?: number;
}

export interface Vegetation {
  grass: VegetationGrass;
  trees: VegetationTrees;
  shrubs: VegetationShrubs;
  flowers: VegetationFlowers;
  special: VegetationSpecial;
}

// ---------------------------------------------------------------------------
// Agua
// ---------------------------------------------------------------------------

/** Cuerpos de agua vistos en las fichas (Paqo: stream/waterfalls/glacialLake; otras: río, cascada). */
export type WaterBodyType =
  | "stream"
  | "waterfalls"
  | "glacialLake"
  | "river"
  | "pond"
  | "lake"
  | (string & {});

export interface Water {
  present: boolean;
  bodies: WaterBodyType[];
  color: HexColor;
  flowSpeed: number;
  foam: number;
  reflectivity: number;
}

// ---------------------------------------------------------------------------
// Cielo
// ---------------------------------------------------------------------------

/** §2: clearNight|overcastDawn|canopyGodrays|duskGradient|caveInterior|tentCanopy */
export type SkyPreset =
  | "clearNight"
  | "overcastDawn"
  | "canopyGodrays"
  | "duskGradient"
  | "caveInterior"
  | "tentCanopy";

export interface SkyGodrays {
  enabled: boolean;
  intensity?: number;
  color?: HexColor;
}

export interface Sky {
  preset: SkyPreset;
  gradientTop: HexColor;
  gradientBottom: HexColor;
  sunVisible: boolean;
  moon: boolean;
  stars: boolean;
  milkyWay: boolean;
  godrays: SkyGodrays;
}

// ---------------------------------------------------------------------------
// Iluminación
// ---------------------------------------------------------------------------

export interface Lighting {
  keyColor: HexColor;
  keyIntensity: number;
  keyAngle: number;
  ambientColor: HexColor;
  ambientIntensity: number;
  shadowSoftness: number;
  /** Bandas de la rampa toon: 2 para terreno/follaje, 3 para personajes (§4). */
  celBands: number;
}

// ---------------------------------------------------------------------------
// Niebla
// ---------------------------------------------------------------------------

export type FogType = "exp2" | "linear";

export interface FogGroundLayer {
  enabled: boolean;
  height: number;
  rolling: boolean;
}

export interface Fog {
  type: FogType;
  color: HexColor;
  density: number;
  groundLayer: FogGroundLayer;
}

// ---------------------------------------------------------------------------
// Partículas
// ---------------------------------------------------------------------------

/** §2: mist|spores|spray|dust|fireflies|glitch|dataBits|stardust|sandDrift|pollen */
export type ParticleType =
  | "mist"
  | "spores"
  | "spray"
  | "dust"
  | "fireflies"
  | "glitch"
  | "dataBits"
  | "stardust"
  | "sandDrift"
  | "pollen";

export interface Particle {
  type: ParticleType;
  density: number;
  color?: HexColor;
  size?: number;
  /** Ancla opcional a otro elemento de la escena, p.ej. "waterfalls". */
  anchor?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type PropType =
  | "guardianTree"
  | "menhirRock"
  | "totemMount"
  | (string & {});

export type PropPlacement = "edges" | "centralClearing" | "scattered" | (string & {});

export interface Prop {
  type: PropType;
  count: number;
  placement?: PropPlacement;
  scale?: number;
}

// ---------------------------------------------------------------------------
// Post-procesado
// ---------------------------------------------------------------------------

export type ColorGrade = "cool" | "warm" | "neutral" | "dramatic" | (string & {});

export interface PostFxOutline {
  enabled: boolean;
  thickness: number;
  color: HexColor;
}

export interface PostFx {
  bloom: number;
  outline: PostFxOutline;
  colorGrade: ColorGrade;
}

// ---------------------------------------------------------------------------
// Preset completo
// ---------------------------------------------------------------------------

export interface BiospherePreset {
  id: string;
  mood: string[];
  palette: Palette;
  terrain: Terrain;
  vegetation: Vegetation;
  water: Water;
  sky: Sky;
  lighting: Lighting;
  fog: Fog;
  particles: Particle[];
  props: Prop[];
  postFx: PostFx;
}

// ---------------------------------------------------------------------------
// Oráculos (voces / system prompts)
// ---------------------------------------------------------------------------

/**
 * Los 11 Oráculos de la constelación (Eme y Uru es uno doble). Los 6
 * primeros son los prioritarios de la beta (PLAN-MAESTRO §6); los otros 5
 * llegan en fases posteriores. Ver `docs/investigacion/01-lore-phygitalia.md`.
 */
export type OracleId =
  | "paqo"
  | "cosmogenes"
  | "eme-y-uru"
  | "espinosito"
  | "nin"
  | "brangulio"
  | "mavea"
  | "chemajo"
  | "tecnomancio"
  | "baba-totik"
  | "personage";

/**
 * Ficha declarativa de un Oráculo: su identidad, su voz (system prompt que
 * alimenta al modelo de la API `/api/oracle`) y los textos diegéticos que el
 * mundo 3D usa para presentarlo (saludo público y mensajes-pista).
 */
export interface OracleDefinition {
  /** Identificador estable, usado en rutas, registry y biósferas. */
  id: OracleId;
  /** Nombre mostrado, p.ej. "Paqo", "Eme y Uru". */
  name: string;
  /** Color de acento de marca del Oráculo (hex). */
  color: HexColor;
  /**
   * System prompt COMPLETO en español mexicano que encarna su voz. Se
   * inyecta tal cual como mensaje de sistema del modelo por conversación.
   */
  systemPrompt: string;
  /** Saludo corto para el canal público de su Biósfera. */
  publicGreeting: string;
  /**
   * Mensajes-pista diegéticos que el Oráculo "susurra" a quien deambula por
   * su Biósfera buscándolo (toasts por proximidad/tiempo). Cortos (<120
   * chars), misteriosos, en su voz.
   */
  hints: string[];
}
