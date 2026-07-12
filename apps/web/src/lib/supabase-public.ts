/**
 * Cliente Supabase de SERVIDOR para LECTURA PÚBLICA (sin sesión).
 *
 * Usa la clave `anon` (pública) desde el servidor, sin persistir sesión: sirve
 * para leer datos que la RLS ya expone a `anon`, como la vista `public_profiles`
 * (perfiles públicos con los flags de privacidad aplicados server-side).
 *
 * NO da acceso privilegiado (no es service-role): la RLS sigue mandando. Se usa
 * en Server Components / generateMetadata donde no hay sesión del usuario (la
 * sesión del navegador vive en localStorage y no llega al servidor en este
 * proyecto, que aún no monta cookies de auth).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Devuelve el cliente anónimo de servidor (singleton) o `null` si faltan envs. */
export function getPublicServerClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  cached = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** Perfil público tal como lo proyecta la vista `public_profiles`. */
export interface PublicProfile {
  id: string;
  handle: string;
  bio: string | null;
  website: string | null;
  social: Record<string, string>;
  avatar: { archetype?: string; tint?: string } | null;
  /** Sólo presente si `birthdate_public` está activo (la vista lo aplica). */
  birthdate: string | null;
  /** Sólo presente si `location_public` está activo. */
  location: string | null;
  created_at: string;
}

/**
 * Lee un perfil público por handle (case-insensitive, la columna es citext).
 * Devuelve null si no existe o si Supabase no está configurado.
 */
export async function fetchPublicProfile(handle: string): Promise<PublicProfile | null> {
  const supabase = getPublicServerClient();
  if (!supabase) return null;
  const clean = handle.trim();
  if (!clean) return null;
  try {
    const { data, error } = await supabase
      .from("public_profiles")
      .select("id, handle, bio, website, social, avatar, birthdate, location, created_at")
      .eq("handle", clean)
      .maybeSingle();
    if (error || !data) return null;
    return data as PublicProfile;
  } catch {
    return null;
  }
}
