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
import { getCaptchaToken } from "./captcha";

let cached: SupabaseClient | null = null;

/**
 * Promesa en vuelo compartida del signup anónimo. Deduplica llamadas
 * CONCURRENTES a `ensureAnonSession` (realtime.ts y notifications.ts la invocan
 * a la vez al cargar la página) para no lanzar dos `signInAnonymously` en
 * paralelo. Se limpia al resolver/rechazar, de modo que reintentos posteriores
 * vuelven a intentar.
 */
let anonSignInPromise: Promise<Session> | null = null;

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
 *
 * CAPTCHA: si la protección CAPTCHA de Supabase está ACTIVA (Auth → Attack
 * Protection), Supabase exige un `captchaToken` de Turnstile en CADA signup; sin
 * él responde 400 `captcha_failed`. Por eso pedimos un token con
 * `getCaptchaToken()` (que resuelve null si no hay site key / DOM) y lo pasamos
 * cuando existe. Las llamadas concurrentes comparten un solo signup (dedup).
 */
export async function ensureAnonSession(): Promise<Session> {
  const supabase = getSupabaseBrowserClient();
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) return existing.session;

  // Dedup: si ya hay un signup anónimo en vuelo, reutilízalo (evita el doble
  // signInAnonymously de realtime.ts + notifications.ts al arrancar).
  if (anonSignInPromise) return anonSignInPromise;

  anonSignInPromise = (async () => {
    // Token Turnstile de un solo uso (o null si el captcha no aplica/está apagado).
    const captchaToken = await getCaptchaToken();
    const { data, error } = await supabase.auth.signInAnonymously(
      captchaToken ? { options: { captchaToken } } : undefined
    );
    if (error || !data.session) {
      const message = error?.message ?? "";
      const code = (error as { code?: string } | null)?.code ?? "";
      // Fallo de captcha: mensaje accionable para diagnosticar desde la consola.
      if (/captcha/i.test(message) || /captcha/i.test(code)) {
        throw new Error(
          "No se pudo iniciar sesión anónima: Turnstile rechazó la petición (captcha). " +
            "La protección CAPTCHA de Supabase está activa y exige un token válido. " +
            "Revisa que NEXT_PUBLIC_TURNSTILE_SITE_KEY esté definida y que en el dashboard " +
            "de Supabase (Auth → Attack Protection) el proveedor sea Turnstile con la secret " +
            `key correcta. Detalle: ${message || "sin mensaje"}`
        );
      }
      throw new Error(`No se pudo iniciar sesión anónima: ${message || "sin sesión"}`);
    }
    return data.session;
  })().finally(() => {
    anonSignInPromise = null;
  });

  return anonSignInPromise;
}
