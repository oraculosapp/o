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
import { ARCHETYPES, isArchetypeId } from "./avatars";
import { getSupabaseBrowserClient } from "./supabase";

export interface AvatarTint {
  primary: string;
  secondary: string;
  hair: string;
}

export interface AvatarSelection {
  /** id de arquetipo procedural (ver ARCHETYPES). */
  archetype: string;
  tint: AvatarTint;
}

/** Config serializable que se pasa a PaqoWorld (hex, no THREE). */
export interface AvatarWorldConfig {
  /** Id del arquetipo PROCEDURAL — el mundo construye el chibi con `buildArchetype`. */
  archetype: string;
  tint: AvatarTint;
}

const KEY = "phy:avatar";
const TINT_KEY = "phy:tint"; // compartida con la presencia (oracle-client)

/** Tres paletas de marca para los swatches del selector (cerámica/dorado/índigo). */
export const AVATAR_TINTS: { name: string; tint: AvatarTint }[] = [
  { name: "Bosque", tint: { primary: "#6b8e4e", secondary: "#c9a96b", hair: "#3a2f18" } },
  { name: "Vampiro", tint: { primary: "#8e1b2e", secondary: "#141726", hair: "#0e1512" } },
  { name: "Dorado", tint: { primary: "#e3b063", secondary: "#7a86c8", hair: "#3a2f2a" } },
];

const DEFAULT_TINT = AVATAR_TINTS[0].tint;

/** Selección por defecto (primer arquetipo, paleta Bosque). */
export function defaultSelection(): AvatarSelection {
  return { archetype: ARCHETYPES[0].id, tint: { ...DEFAULT_TINT } };
}

/** Normaliza un objeto arbitrario (localStorage/jsonb) a una selección válida. */
function normalize(raw: unknown): AvatarSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.archetype !== "string" || !isArchetypeId(r.archetype)) return null;
  const t = (r.tint && typeof r.tint === "object" ? r.tint : {}) as Record<string, unknown>;
  const hex = (v: unknown, fallback: string) =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  return {
    archetype: r.archetype,
    tint: {
      primary: hex(t.primary, DEFAULT_TINT.primary),
      secondary: hex(t.secondary, DEFAULT_TINT.secondary),
      hair: hex(t.hair, DEFAULT_TINT.hair),
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
 * Config del mundo derivada de una selección: sólo el `archetype` (id) para el
 * camino PROCEDURAL — el mundo construye el chibi al instante — y el tinte.
 */
export function worldConfigFromSelection(sel: AvatarSelection): AvatarWorldConfig {
  return {
    archetype: sel.archetype,
    tint: sel.tint,
  };
}

/** Id del arquetipo almacenado (o undefined) — lo transmite la presencia. */
export function getStoredArchetype(): string | undefined {
  return getStoredAvatar()?.archetype;
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
      .update({ avatar: { archetype: sel.archetype, tint: sel.tint } })
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
