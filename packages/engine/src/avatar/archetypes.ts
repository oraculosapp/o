import type { IAvatarRig } from "./types";
import { buildChibi, type ArchetypeSpec } from "./ChibiAvatar";

/**
 * Los 9 arquetipos de Phygitalia como especificaciones declarativas para
 * {@link buildChibi}. Fieles a las láminas de referencia (assets/avatares):
 * reconocibilidad = silueta + prop icónico + acento de color. Los detalles finos
 * (código, estrellas, salpicaduras, filigrana) van por COLOR/emisivo, no por
 * geometría cara.
 *
 * Sin género: son 9 avatares distintos. Cada uno tiene su tinte por defecto y es
 * compatible con `setTint` (primary = ropa principal).
 */

/** Ids canónicos de los 9 arquetipos (mismo orden y nombres que el catálogo de la app). */
export const ARCHETYPE_IDS = [
  "hacker",
  "godines",
  "artista",
  "licenciado",
  "vampiro",
  "astronomo",
  "chaman",
  "bodybuilder",
  "dedo-verde",
] as const;

export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export const ARCHETYPE_SPECS: Record<ArchetypeId, ArchetypeSpec> = {
  // 1 · HACKER — capucha negra, neón verde, gafas AR, audífonos.
  hacker: {
    id: "hacker",
    name: "Hacker",
    palette: { skin: 0xe6b58f, primary: 0x181a1d, secondary: 0x24262b, hair: 0x14140f, accent: 0x8ace3b, shoes: 0x1c1e20 },
    hair: "spiky",
    head: "capucha",
    glasses: "ar",
    coat: "none",
    prop: "none",
    decal: "code",
    headphones: true,
    glow: 0.9,
  },

  // 2 · GODINES — camisa clara, corbata, pantalón oscuro, gafas, maletín.
  godines: {
    id: "godines",
    name: "Godines",
    palette: { skin: 0xd8a57a, primary: 0xe8e2d4, secondary: 0x33353b, hair: 0x4a3423, accent: 0x8a6a3a, shoes: 0x3a2716 },
    hair: "short",
    head: "none",
    glasses: "round",
    coat: "none",
    prop: "maletin",
  },

  // 3 · ARTISTA — boina con pincel, abrigo beige con salpicaduras, bufanda azul.
  artista: {
    id: "artista",
    name: "Artista",
    palette: { skin: 0xe6b58f, primary: 0xcdbb93, secondary: 0x2b2d3a, hair: 0x3a2f2a, accent: 0x5a4b6e, shoes: 0x4a3320 },
    hair: "short",
    head: "boina",
    coat: "long",
    prop: "pincel",
    decal: "splatter",
    scarf: 0x2f3f66,
  },

  // 4 · LICENCIADO — abrigo azul-negro con filigrana dorada, puños claros, libro.
  licenciado: {
    id: "licenciado",
    name: "Licenciado",
    palette: { skin: 0xd8a57a, primary: 0x1b2740, secondary: 0x14161f, hair: 0x241a12, accent: 0xc9a24a, shoes: 0x4a3320 },
    hair: "short",
    head: "none",
    coat: "long",
    prop: "libro",
    decal: "filigree",
    glow: 0.4,
  },

  // 5 · VAMPIRO — cuello-capa alto (negro/rojo interior), traje oscuro, piel pálida, broche.
  vampiro: {
    id: "vampiro",
    name: "Vampiro",
    palette: { skin: 0xecdcd0, primary: 0x17151b, secondary: 0x100f14, hair: 0x1a1620, accent: 0x8e1b2e, shoes: 0x120f16 },
    hair: "spiky",
    head: "cuello-capa",
    coat: "long",
    prop: "none",
    brooch: 0x8e1b2e,
  },

  // 6 · ASTRÓNOMO — túnica azul noche con estrellas doradas, gorro, catalejo.
  astronomo: {
    id: "astronomo",
    name: "Astrónomo",
    palette: { skin: 0xe6b58f, primary: 0x1b2740, secondary: 0x172033, hair: 0x201d2e, accent: 0xd9b24a, shoes: 0x3a2c1a },
    hair: "spiky",
    head: "none",
    coat: "robe",
    prop: "catalejo",
    decal: "stars",
    glow: 0.9,
  },

  // 7 · CHAMÁN — túnica verde oliva, pelo blanco largo, cuentas, cayado.
  chaman: {
    id: "chaman",
    name: "Chamán",
    palette: { skin: 0xc69a6a, primary: 0x5a6b3a, secondary: 0x8a7c52, hair: 0xe8e6df, accent: 0xb6873f, shoes: 0x4a3320 },
    hair: "long",
    head: "pelo-largo",
    beard: true,
    coat: "robe",
    prop: "baston",
    charms: true,
  },

  // 8 · BODYBUILDER — torso desnudo (silueta ancha), arneses de cuero, piel bronceada.
  bodybuilder: {
    id: "bodybuilder",
    name: "Bodybuilder",
    palette: { skin: 0xd99a63, primary: 0x2a2320, secondary: 0x2a2320, hair: 0x3a2718, accent: 0x6b4a2a, shoes: 0x2a1f16 },
    body: "wide",
    bareTorso: true,
    hair: "spiky",
    head: "none",
    beard: true,
    coat: "none",
    prop: "none",
  },

  // 9 · DEDO VERDE — overol verde-azul, sombrero de ala con hojas, barba, regadera.
  "dedo-verde": {
    id: "dedo-verde",
    name: "Dedo Verde",
    palette: { skin: 0xcf9a6a, primary: 0x4f7d78, secondary: 0x6d7d45, hair: 0x4a3423, accent: 0xb89a4a, shoes: 0x4a3320 },
    hair: "short",
    head: "sombrero-ala",
    beard: true,
    coat: "none",
    prop: "regadera",
    leaves: true,
  },
};

/** ¿Es `id` uno de los 9 arquetipos procedurales? */
export function isArchetypeId(id: string): id is ArchetypeId {
  return (ARCHETYPE_IDS as readonly string[]).includes(id);
}

/** Builds de cuerpo de los avatares modelados: femenino / masculino / neutro. */
export const BUILD_IDS = ["f", "m", "n"] as const;
export type BuildId = (typeof BUILD_IDS)[number];

/** Ruta pública base de los GLB generados por Blender (tools/avatars/generate.py). */
export const GEN_AVATAR_PREFIX = "/assets/avatars/gen/";

/**
 * Avatar "nube" (S8): el ÚNICO diseño NEUTRO tipo plastilina. Un solo GLB
 * (materiales body+eyes, esqueleto Mixamo) que se tinta por color en el engine.
 * Reemplaza a los 9 arquetipos + builds como diseño por defecto de todos.
 */
export const NUBE_ID = "nube";
export const NUBE_GLB_URL = `${GEN_AVATAR_PREFIX}nube.glb`;

/** ¿Es `id` el diseño "nube"? */
export function isNubeId(id: string): boolean {
  return id === NUBE_ID;
}

/**
 * Parsea un id de avatar MODELADO `"<arquetipo>-<f|m|n>"` (p.ej. `"vampiro-f"`,
 * `"dedo-verde-n"`) en sus partes. Devuelve `null` si no encaja (incluye los 9
 * ids de arquetipo "pelados" viejos como `"vampiro"`, que NO son ids de avatar).
 * Corta por el ÚLTIMO guion para respetar arquetipos con guion (`dedo-verde`).
 */
export function parseAvatarId(id: string): { archetype: ArchetypeId; build: BuildId } | null {
  if (typeof id !== "string") return null;
  const i = id.lastIndexOf("-");
  if (i <= 0) return null;
  const base = id.slice(0, i);
  const build = id.slice(i + 1);
  if (isArchetypeId(base) && (BUILD_IDS as readonly string[]).includes(build)) {
    return { archetype: base, build: build as BuildId };
  }
  return null;
}

/** ¿Es `id` un id de avatar modelado válido (`"<arquetipo>-<f|m|n>"`)? */
export function isAvatarId(id: string): boolean {
  return parseAvatarId(id) !== null;
}

/** URL same-origin del GLB modelado de un id de avatar, o `null` si el id no es válido. */
export function avatarGlbUrl(id: string): string | null {
  if (isNubeId(id)) return NUBE_GLB_URL; // el diseño "nube" → su único GLB
  const p = parseAvatarId(id);
  return p ? `${GEN_AVATAR_PREFIX}${p.archetype}-${p.build}.glb` : null;
}

/**
 * Construye el rig procedural de un arquetipo por id. Si el id no existe, cae al
 * primero (hacker) — nunca falla, porque los 9 son 100% código (no hay GLB que
 * pueda faltar). Este es el punto de entrada que el mundo y el preview consumen.
 */
export function buildArchetype(id: string): IAvatarRig {
  const spec = ARCHETYPE_SPECS[(isArchetypeId(id) ? id : "hacker") as ArchetypeId];
  return buildChibi(spec);
}

/** Devuelve la especificación de un arquetipo (o la de hacker si el id no existe). */
export function archetypeSpec(id: string): ArchetypeSpec {
  return ARCHETYPE_SPECS[(isArchetypeId(id) ? id : "hacker") as ArchetypeId];
}
