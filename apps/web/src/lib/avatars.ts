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

/** URL pública de la miniatura del arquetipo. */
export function thumbUrl(id: string): string {
  return `/assets/avatars/thumbs/${id}.webp`;
}

/**
 * Los 18 nombres de archivo (sin `.glb`) en el orden del catálogo — para el
 * desplegable de prueba del laboratorio (`hacker-m`, `hacker-f`, `godines-m`, …).
 */
export function avatarFileNames(): string[] {
  return ARCHETYPES.flatMap((a) => [`${a.id}-m`, `${a.id}-f`]);
}
