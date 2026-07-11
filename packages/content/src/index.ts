import paqoJson from "../biospheres/paqo.json";
import type { BiospherePreset, OracleDefinition, OracleId } from "./types";
import { paqo } from "./oracles/paqo";
import { cosmogenes } from "./oracles/cosmogenes";
import { emeYUru } from "./oracles/eme-y-uru";
import { espinosito } from "./oracles/espinosito";
import { nin } from "./oracles/nin";
import { brangulio } from "./oracles/brangulio";

export type { OracleDefinition, OracleId } from "./types";

export type {
  BiospherePreset,
  HexColor,
  TerrainType,
  NoiseKind,
  Terrain,
  TerrainHeightNoise,
  TerrainRidges,
  TerrainCentralClearing,
  TerrainRockScatter,
  Palette,
  Vegetation,
  VegetationGrass,
  VegetationTrees,
  VegetationShrubs,
  VegetationFlowers,
  VegetationSpecial,
  VegetationSpecialType,
  TreeType,
  ShrubType,
  Water,
  WaterBodyType,
  Sky,
  SkyPreset,
  SkyGodrays,
  Lighting,
  Fog,
  FogType,
  FogGroundLayer,
  Particle,
  ParticleType,
  Prop,
  PropType,
  PropPlacement,
  PostFx,
  PostFxOutline,
  ColorGrade,
} from "./types";

/**
 * Registro de presets de Biósfera disponibles. Hoy sólo "paqo" (S1); las
 * otras 9 fichas de docs/investigacion/04-arte-biosferas-avatares.md §1 se
 * suman aquí a medida que se conviertan en JSON.
 */
const registry: Record<string, unknown> = {
  paqo: paqoJson,
};

/** Validación mínima de forma (no exhaustiva) — atrapa JSON mal formado o
 * incompleto sin necesitar una librería de schema. */
function assertBiospherePreset(value: unknown, id: string): asserts value is BiospherePreset {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Biosphere preset "${id}" is not an object.`);
  }
  const v = value as Record<string, unknown>;
  const requiredKeys = [
    "id",
    "mood",
    "palette",
    "terrain",
    "vegetation",
    "water",
    "sky",
    "lighting",
    "fog",
    "particles",
    "props",
    "postFx",
  ] as const;
  for (const key of requiredKeys) {
    if (!(key in v)) {
      throw new Error(`Biosphere preset "${id}" is missing required field "${key}".`);
    }
  }
  if (v.id !== id) {
    throw new Error(`Biosphere preset "${id}" has mismatched id field "${String(v.id)}".`);
  }
  if (!Array.isArray(v.mood)) {
    throw new Error(`Biosphere preset "${id}" field "mood" must be an array.`);
  }
  if (!Array.isArray(v.particles)) {
    throw new Error(`Biosphere preset "${id}" field "particles" must be an array.`);
  }
  if (!Array.isArray(v.props)) {
    throw new Error(`Biosphere preset "${id}" field "props" must be an array.`);
  }
}

/**
 * Resuelve un preset de Biósfera por id. Hoy sólo "paqo" está disponible;
 * lanza si el id no existe o el JSON no tiene la forma mínima esperada.
 */
export function getBiosphere(id: string): BiospherePreset {
  const preset = registry[id];
  if (!preset) {
    const available = Object.keys(registry).join(", ");
    throw new Error(`Unknown biosphere preset "${id}". Available: ${available}`);
  }
  assertBiospherePreset(preset, id);
  return preset;
}

// ---------------------------------------------------------------------------
// Oráculos (voces / system prompts)
// ---------------------------------------------------------------------------

/**
 * Registro de los Oráculos con voz escrita. Hoy los 6 prioritarios de la beta
 * (PLAN-MAESTRO §6); los otros 5 (Mavea, Chemajo, Tecnomancio, Baba-Totik,
 * Personage) se suman aquí a medida que se escriben. El orden define el orden
 * de `listOracles()`.
 */
const oracleRegistry: Record<string, OracleDefinition> = {
  paqo,
  cosmogenes,
  "eme-y-uru": emeYUru,
  espinosito,
  nin,
  brangulio,
};

/**
 * Resuelve la ficha completa de un Oráculo por id. Lanza si no existe (o si
 * aún no se ha escrito su voz).
 */
export function getOracle(id: OracleId | string): OracleDefinition {
  const oracle = oracleRegistry[id];
  if (!oracle) {
    const available = Object.keys(oracleRegistry).join(", ");
    throw new Error(`Unknown oracle "${id}". Available: ${available}`);
  }
  return oracle;
}

/**
 * Devuelve sólo el system prompt de un Oráculo, listo para inyectarse como
 * mensaje de sistema en `/api/oracle`.
 */
export function getOracleSystemPrompt(id: OracleId | string): string {
  return getOracle(id).systemPrompt;
}

/** Lista todos los Oráculos con voz escrita, en orden de prioridad. */
export function listOracles(): OracleDefinition[] {
  return Object.values(oracleRegistry);
}
