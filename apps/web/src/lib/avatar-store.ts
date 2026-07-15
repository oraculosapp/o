/**
 * Selección de avatar del viajero: persistencia (localStorage + jsonb del perfil),
 * paletas de tinte y utilidades para el mundo/presencia.
 *
 * Contrato de la config del mundo (lo consume PaqoWorld.setAvatar):
 *   { archetype: string; tint?: { primary, secondary, hair } }
 *
 * Los 9 avatares son PROCEDURALES (chibi rigged construidos en código por el
 * engine): se identifican por su `archetype` id (p.ej. "vampiro"), no por una URL
 * de GLB, y todos están disponibles siempre (no hay estado "aún duerme"). Sin
 * género: son 9 avatares distintos.
 *
 * La selección se guarda en:
 *   · localStorage `phy:avatar` (siempre, también anónimos).
 *   · `phy:tint` (el color primario) — la misma clave que ya usa la presencia del
 *     chat (lib/oracle-client), para que los demás te vean con tu color sin tocar
 *     el chat.
 *   · columna `avatar` (jsonb) del perfil, sólo si el usuario está registrado.
 */
import { ARCHETYPES, isArchetypeId, isBuildId, genGlbUrl, avatarId, DEFAULT_BUILD, type BuildId } from "./avatars";
import { getSupabaseBrowserClient } from "./supabase";

/** Tinte por las 5 zonas (multiplicador; blanco `#ffffff` = color de fábrica). */
export interface AvatarTint {
  primary: string;
  secondary: string;
  hair: string;
  skin: string;
  accent: string;
}

export interface AvatarSelection {
  /** id de arquetipo (uno de los 9 de ARCHETYPES). */
  archetype: string;
  /** Build de cuerpo del avatar modelado. */
  build: BuildId;
  tint: AvatarTint;
}

/** Config serializable que se pasa a PaqoWorld (hex, no THREE). */
export interface AvatarWorldConfig {
  /** URL del GLB modelado del avatar (el mundo lo carga con `loadAvatarRigShared`). */
  archetypeUrl: string;
  tint: AvatarTint;
}

const KEY = "phy:avatar";
const TINT_KEY = "phy:tint"; // compartida con la presencia (oracle-client)

/** Blanco = sin tinte (el avatar se ve con los colores de fábrica que modelé). */
const WHITE = "#ffffff";

/** Tinte por defecto: fábrica (blanco en las 5 zonas → colores diseñados). */
const DEFAULT_TINT: AvatarTint = {
  primary: WHITE,
  secondary: WHITE,
  hair: WHITE,
  skin: WHITE,
  accent: WHITE,
};

/** Paletas de marca de acceso rápido para el editor (5 zonas). */
export const AVATAR_TINTS: { name: string; tint: AvatarTint }[] = [
  { name: "Fábrica", tint: { ...DEFAULT_TINT } },
  { name: "Bosque", tint: { primary: "#8fb36a", secondary: "#c9a96b", hair: "#5a4a2e", skin: WHITE, accent: "#e3b063" } },
  { name: "Vampiro", tint: { primary: "#b0475a", secondary: "#6a6f86", hair: "#7a6f86", skin: WHITE, accent: "#e05a6e" } },
  { name: "Dorado", tint: { primary: "#e3b063", secondary: "#9aa4d8", hair: "#8a6a4a", skin: WHITE, accent: "#ffd98a" } },
];

/** Selección por defecto (primer arquetipo, build neutro, colores de fábrica). */
export function defaultSelection(): AvatarSelection {
  return { archetype: ARCHETYPES[0].id, build: DEFAULT_BUILD, tint: { ...DEFAULT_TINT } };
}

/** Normaliza un objeto arbitrario (localStorage/jsonb) a una selección válida.
 *  Tolera el formato VIEJO (sin `build`, tinte de 3 zonas): rellena build neutro
 *  y skin/accent en blanco — así los usuarios con localStorage antiguo siguen. */
function normalize(raw: unknown): AvatarSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.archetype !== "string" || !isArchetypeId(r.archetype)) return null;
  const build = typeof r.build === "string" && isBuildId(r.build) ? r.build : DEFAULT_BUILD;
  const t = (r.tint && typeof r.tint === "object" ? r.tint : {}) as Record<string, unknown>;
  const hex = (v: unknown, fallback: string) =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  return {
    archetype: r.archetype,
    build,
    tint: {
      primary: hex(t.primary, DEFAULT_TINT.primary),
      secondary: hex(t.secondary, DEFAULT_TINT.secondary),
      hair: hex(t.hair, DEFAULT_TINT.hair),
      skin: hex(t.skin, DEFAULT_TINT.skin),
      accent: hex(t.accent, DEFAULT_TINT.accent),
    },
  };
}

/** Lee la selección de localStorage (o null si no hay/está corrupta). */
export function getStoredAvatar(): AvatarSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Persiste la selección en localStorage + sincroniza `phy:tint` (presencia). */
export function storeAvatar(sel: AvatarSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sel));
    window.localStorage.setItem(TINT_KEY, sel.tint.primary);
  } catch {
    /* cuota llena / modo privado: no es crítico */
  }
}

/**
 * Config del mundo derivada de una selección: la URL del GLB MODELADO (arquetipo
 * + build) para que el mundo lo cargue, y el tinte de 5 zonas. Si el GLB fallara,
 * el llamador (page) cae con gracia al chibi procedural del arquetipo.
 */
export function worldConfigFromSelection(sel: AvatarSelection): AvatarWorldConfig {
  return {
    archetypeUrl: genGlbUrl(sel.archetype, sel.build),
    tint: sel.tint,
  };
}

/**
 * Id de avatar almacenado (`"<arquetipo>-<build>"`, p.ej. `"vampiro-f"`) — lo
 * transmite la presencia para que los remotos carguen el MISMO GLB modelado.
 */
export function getStoredArchetype(): string | undefined {
  const sel = getStoredAvatar();
  return sel ? avatarId(sel.archetype, sel.build) : undefined;
}

/** Color primario almacenado (o undefined) — la usa la presencia. */
export function getStoredPrimaryTint(): string | undefined {
  return getStoredAvatar()?.tint.primary;
}

/** Guarda la selección en el perfil (jsonb `avatar`) si el usuario está registrado. */
export async function saveAvatarToProfile(sel: AvatarSelection): Promise<void> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user || user.is_anonymous) return; // anónimo: sólo localStorage
    await supabase
      .from("profiles")
      .update({ avatar: { archetype: sel.archetype, build: sel.build, tint: sel.tint } })
      .eq("id", user.id);
  } catch (err) {
    console.warn("[avatar] no se pudo guardar el avatar en el perfil:", err);
  }
}

/** Carga la selección del perfil (jsonb `avatar`) — null si no hay/no aplica. */
export async function loadAvatarFromProfile(): Promise<AvatarSelection | null> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase.from("profiles").select("avatar").maybeSingle();
    return normalize(data?.avatar);
  } catch {
    return null;
  }
}
