/**
 * Catálogo de arquetipos de avatar (única fuente de verdad para selector, mundo,
 * presencia y laboratorio /dev/avatar).
 *
 * Convención de archivos (docs/avatares-tripo3d.md §5):
 *   `<arquetipo>-<m|f>.glb` en `apps/web/public/assets/avatars/`.
 * Miniaturas (generadas por tools/assets/gen-avatar-thumbs.mjs desde las láminas):
 *   `apps/web/public/assets/avatars/thumbs/<arquetipo>.webp`.
 */

export type Gender = "m" | "f";

/** Los tres builds de cuerpo de los avatares modelados. */
export type BuildId = "f" | "m" | "n";

export interface Build {
  id: BuildId;
  /** Nombre visible. */
  name: string;
  /** Etiqueta corta para los chips (F/M/N). */
  short: string;
}

/** Femenina (caderas + melena) · Masculina (hombros) · Neutra (andrógino). */
export const BUILDS: readonly Build[] = [
  { id: "f", name: "Femenina", short: "F" },
  { id: "m", name: "Masculina", short: "M" },
  { id: "n", name: "Neutra", short: "N" },
] as const;

/** Build por defecto (andrógino) para selecciones nuevas o legadas sin build. */
export const DEFAULT_BUILD: BuildId = "n";

export function isBuildId(b: string): b is BuildId {
  return b === "f" || b === "m" || b === "n";
}

export interface Archetype {
  /** Identificador y prefijo de archivo (minúsculas, guion). */
  id: string;
  /** Nombre visible (Chakra Petch en el selector). */
  name: string;
}

/** Los 9 arquetipos (× M/F = 18 modelos). Orden = orden de las láminas. */
export const ARCHETYPES: readonly Archetype[] = [
  { id: "hacker", name: "Hacker" },
  { id: "godines", name: "Godines" },
  { id: "artista", name: "Artista" },
  { id: "licenciado", name: "Licenciado" },
  { id: "vampiro", name: "Vampiro" },
  { id: "astronomo", name: "Astrónomo" },
  { id: "chaman", name: "Chamán" },
  { id: "bodybuilder", name: "Bodybuilder" },
  { id: "dedo-verde", name: "Dedo Verde" },
] as const;

/**
 * Los 9 ids en orden (fuente de verdad para el selector/splash PROCEDURAL). Todos
 * DISPONIBLES: los avatares son chibi rigged construidos en código por el engine
 * (`buildArchetype(id)`), así que no hay GLB que pueda faltar ni estado “aún
 * duerme”. El selector consume por id; el mundo obtiene el rig con
 * `buildArchetype`. Sin género: son 9 avatares distintos.
 */
export const ARCHETYPE_IDS: readonly string[] = ARCHETYPES.map((a) => a.id);

/** ¿Existe un arquetipo con ese id? */
export function isArchetypeId(id: string): boolean {
  return ARCHETYPES.some((a) => a.id === id);
}

/**
 * Modelos GLB ya MATERIALIZADOS (por slot `<arquetipo>-<m|f>`). Los demás "aún
 * duermen": el mundo cae con gracia al maniquí procedural con su tinte hasta que
 * lleguen sus riggeados. Fuente de verdad declarativa — al procesar un arquetipo
 * con `tools/assets` (npm run optimize:avatars) añade aquí su slot.
 *
 * `hacker-f`: primer avatar real (Sketchfab + rig Mixamo). Sin clips de
 * locomoción → lo anima ProceduralLocomotion sobre los huesos Mixamo.
 */
export const AVAILABLE_AVATARS: ReadonlySet<string> = new Set<string>(["hacker-f"]);

/** ¿El GLB de este slot ya está disponible (marcado en el catálogo)? */
export function isAvatarAvailable(id: string, gender: Gender): boolean {
  return AVAILABLE_AVATARS.has(`${id}-${gender}`);
}

/** URL pública del GLB del arquetipo (p.ej. `/assets/avatars/hacker-m.glb`). */
export function archetypeUrl(id: string, gender: Gender): string {
  return `/assets/avatars/${id}-${gender}.glb`;
}

// --- Avatares MODELADOS (Blender): id "<arquetipo>-<f|m|n>" ------------------

/** Id de avatar modelado: `"<arquetipo>-<f|m|n>"` (p.ej. `"vampiro-f"`). */
export function avatarId(archetype: string, build: BuildId): string {
  return `${archetype}-${build}`;
}

/** Parsea `"<arquetipo>-<f|m|n>"` (corta por el ÚLTIMO guion → respeta `dedo-verde`). */
export function parseAvatarId(id: string): { archetype: string; build: BuildId } | null {
  const i = id.lastIndexOf("-");
  if (i <= 0) return null;
  const archetype = id.slice(0, i);
  const build = id.slice(i + 1);
  if (isArchetypeId(archetype) && isBuildId(build)) return { archetype, build };
  return null;
}

/** ¿Es `id` un id de avatar modelado válido? (los 9 ids "pelados" viejos → false). */
export function isAvatarId(id: string): boolean {
  return parseAvatarId(id) !== null;
}

/** URL pública del GLB modelado (Blender) — `/assets/avatars/gen/<arq>-<build>.glb`. */
export function genGlbUrl(archetype: string, build: BuildId): string {
  return `/assets/avatars/gen/${archetype}-${build}.glb`;
}

/**
 * URL pública de la miniatura MODELADA (render Blender por build). Reemplaza a las
 * viejas miniaturas de láminas: `/assets/avatars/thumbs/gen/<arq>-<build>.webp`.
 */
export function thumbUrl(archetype: string, build: BuildId = DEFAULT_BUILD): string {
  return `/assets/avatars/thumbs/gen/${archetype}-${build}.webp`;
}

/**
 * Los 18 nombres de archivo (sin `.glb`) en el orden del catálogo — para el
 * desplegable de prueba del laboratorio (`hacker-m`, `hacker-f`, `godines-m`, …).
 */
export function avatarFileNames(): string[] {
  return ARCHETYPES.flatMap((a) => [`${a.id}-m`, `${a.id}-f`]);
}
