/**
 * Cliente de navegador para el PERFIL propio (`/usuario`).
 *
 * Toda la I/O pasa por el cliente browser autenticado (RLS owner-only de
 * `profiles` / `progress`). La sesión del usuario (anónima o registrada) vive en
 * localStorage; aquí sólo la leemos.
 *
 * Reglas de negocio (PLAN-MAESTRO §3 / §5):
 *   · handle único (citext) — validamos unicidad antes de guardar con un mensaje
 *     claro; la restricción de la BD es la red de seguridad final.
 *   · bio máx 280; website + redes sociales (lista de {label, url}); fecha de
 *     nacimiento y ubicación con flag público/privado individual.
 */
import { getSupabaseBrowserClient } from "./supabase";

/** Enlace social editable en el formulario (lista dinámica). */
export interface SocialLink {
  label: string;
  url: string;
}

/** Datos editables del perfil propio (subconjunto de `profiles`). */
export interface ProfileData {
  handle: string;
  bio: string;
  website: string;
  social: SocialLink[];
  birthdate: string; // 'YYYY-MM-DD' o ''
  location: string;
  birthdatePublic: boolean;
  locationPublic: boolean;
}

export interface ProfileProgress {
  unlockedBiospheres: string[];
  foundOracles: string[];
  arrivedAt: string | null; // created_at del perfil = "llegada a Phygitalia"
}

export interface ProfileSession {
  userId: string;
  /** true si el usuario está registrado (no anónimo). */
  registered: boolean;
}

export const BIO_MAX = 280;
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
const HANDLE_RE = /^[a-z0-9_-]+$/;

/** Normaliza el objeto `social` (jsonb) a la lista ordenada del formulario. */
function socialFromJson(raw: unknown): SocialLink[] {
  if (!raw || typeof raw !== "object") return [];
  const entries = Object.entries(raw as Record<string, unknown>);
  return entries
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([label, v]) => ({ label, url: String(v) }));
}

/** Serializa la lista del formulario al objeto `social` (jsonb) de la BD. */
export function socialToJson(links: SocialLink[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { label, url } of links) {
    const l = label.trim();
    const u = url.trim();
    if (!l || !u) continue;
    out[l] = u;
  }
  return out;
}

/**
 * Valida un handle según las reglas de marca. Devuelve un mensaje de error
 * legible o null si es válido.
 */
export function validateHandle(handle: string): string | null {
  const h = handle.trim().toLowerCase();
  if (h.length < HANDLE_MIN) return `El handle necesita al menos ${HANDLE_MIN} caracteres.`;
  if (h.length > HANDLE_MAX) return `El handle no puede pasar de ${HANDLE_MAX} caracteres.`;
  if (!HANDLE_RE.test(h)) return "Sólo minúsculas, números, guion y guion bajo.";
  return null;
}

/** Lee la sesión actual (o null si no hay). No crea sesión anónima. */
export async function getProfileSession(): Promise<ProfileSession | null> {
  const supabase = getSupabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  return { userId: user.id, registered: user.is_anonymous !== true };
}

/** Carga el perfil propio. Devuelve null si no existe fila todavía. */
export async function loadProfile(): Promise<ProfileData | null> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("handle, bio, website, social, birthdate, location, birthdate_public, location_public")
    .maybeSingle();
  if (error || !data) return null;
  return {
    handle: data.handle ?? "",
    bio: data.bio ?? "",
    website: data.website ?? "",
    social: socialFromJson(data.social),
    birthdate: data.birthdate ?? "",
    location: data.location ?? "",
    birthdatePublic: Boolean(data.birthdate_public),
    locationPublic: Boolean(data.location_public),
  };
}

/** Carga el progreso propio (biósferas / oráculos / fecha de llegada). */
export async function loadProgress(): Promise<ProfileProgress> {
  const supabase = getSupabaseBrowserClient();
  const [{ data: prog }, { data: prof }] = await Promise.all([
    supabase.from("progress").select("unlocked_biospheres, found_oracles").maybeSingle(),
    supabase.from("profiles").select("created_at").maybeSingle(),
  ]);
  return {
    unlockedBiospheres: Array.isArray(prog?.unlocked_biospheres)
      ? (prog!.unlocked_biospheres as string[])
      : ["paqo"],
    foundOracles: Array.isArray(prog?.found_oracles) ? (prog!.found_oracles as string[]) : [],
    arrivedAt: (prof?.created_at as string | undefined) ?? null,
  };
}

/** Resultado de guardar: éxito, o error con motivo legible. */
export type SaveResult = { ok: true } | { ok: false; field?: "handle"; message: string };

/**
 * Guarda el perfil. Valida el handle y su unicidad (mensaje claro) antes del
 * update; la restricción única de la BD es la red final (código 23505).
 */
export async function saveProfile(userId: string, data: ProfileData): Promise<SaveResult> {
  const handle = data.handle.trim().toLowerCase();
  const handleErr = validateHandle(handle);
  if (handleErr) return { ok: false, field: "handle", message: handleErr };

  const supabase = getSupabaseBrowserClient();

  // Unicidad: ¿lo tiene otro usuario? (citext ⇒ comparación case-insensitive).
  try {
    const { data: taken } = await supabase
      .from("public_profiles")
      .select("id")
      .eq("handle", handle)
      .maybeSingle();
    if (taken && taken.id !== userId) {
      return { ok: false, field: "handle", message: "Ese handle ya está tomado. Prueba otro." };
    }
  } catch {
    /* si la comprobación falla, seguimos: la BD hará de red de seguridad */
  }

  const bio = data.bio.trim().slice(0, BIO_MAX);
  const { error } = await supabase
    .from("profiles")
    .update({
      handle,
      bio: bio || null,
      website: data.website.trim() || null,
      social: socialToJson(data.social),
      birthdate: data.birthdate || null,
      location: data.location.trim() || null,
      birthdate_public: data.birthdatePublic,
      location_public: data.locationPublic,
    })
    .eq("id", userId);

  if (error) {
    // 23505 = unique_violation en handle (carrera con la comprobación de arriba).
    if (error.code === "23505") {
      return { ok: false, field: "handle", message: "Ese handle ya está tomado. Prueba otro." };
    }
    return { ok: false, message: "No se pudo guardar. Inténtalo de nuevo." };
  }
  return { ok: true };
}
