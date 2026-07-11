/**
 * Cliente Supabase para el navegador (browser).
 *
 * - Usa las variables públicas NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * - Sesión persistente en localStorage (auto-refresh de tokens).
 * - Helper `ensureAnonSession()` para la política "anónimo por defecto" del PLAN
 *   MAESTRO §3: si no hay sesión, inicia una sesión anónima (signInAnonymously).
 *
 * NO usar en el servidor (route handlers): para eso está `supabase-admin.ts`
 * con la service role key.
 */
import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

function readEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Cópialas de apps/web/.env.example a tu .env.local (o a Vercel)."
    );
  }
  return { url, anonKey };
}

/**
 * Devuelve el cliente browser (singleton). Perezoso: no se instancia hasta el
 * primer uso, de modo que importar este módulo en tests/SSR no exige env vars.
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;
  const { url, anonKey } = readEnv();
  cached = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // magic-link (Resend) al volver del email
    },
  });
  return cached;
}

/**
 * Garantiza una sesión activa. Si el usuario no ha iniciado sesión, crea una
 * sesión ANÓNIMA persistente. Devuelve la sesión resultante.
 *
 * Requiere que "Anonymous sign-ins" esté habilitado en el dashboard de Supabase
 * (Authentication → Providers → Anonymous).
 */
export async function ensureAnonSession(): Promise<Session> {
  const supabase = getSupabaseBrowserClient();
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) return existing.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.session) {
    throw new Error(`No se pudo iniciar sesión anónima: ${error?.message ?? "sin sesión"}`);
  }
  return data.session;
}
