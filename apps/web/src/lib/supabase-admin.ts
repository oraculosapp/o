/**
 * Cliente Supabase de SERVIDOR (service role).
 *
 * ⚠️ SOLO servidor. La SUPABASE_SERVICE_ROLE_KEY omite RLS: nunca debe llegar al
 * navegador. Este módulo no debe importarse desde componentes cliente.
 *
 * Se usa para:
 *   · persistir la memoria privada de los Oráculos (oracle_messages / summary),
 *   · publicar mensajes del Oráculo en el chat público (is_oracle = true),
 *   · moderación (borrado de biosphere_messages).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Devuelve el cliente service-role (singleton) o `null` si faltan las env vars.
 * Devolver null en vez de lanzar permite que las rutas degraden con elegancia
 * (p.ej. chat privado sin memoria) en lugar de romperse.
 */
export function getServiceClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
