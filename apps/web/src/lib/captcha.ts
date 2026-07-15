/**
 * Obtención de un token de Cloudflare Turnstile para el navegador (browser).
 *
 * ¿Para qué? Cuando la protección CAPTCHA está ACTIVA en Supabase (Auth → Attack
 * Protection), TODO `signInAnonymously` / `signInWithOtp` debe llevar un
 * `captchaToken`; si no, Supabase responde 400 `captcha_failed` ("request
 * disallowed (no captcha_token found)"). El RegisterModal ya resuelve esto para
 * el registro por magic-link; este helper hace lo mismo para la sesión anónima
 * silenciosa del arranque del mundo (ver `ensureAnonSession` en supabase.ts).
 *
 * Diseño (calca las convenciones del RegisterModal):
 * - Reutiliza el mismo id de script `cf-turnstile-script`: si ya está en el DOM
 *   (p. ej. lo montó el RegisterModal), NO se inyecta de nuevo; se espera a que
 *   `window.turnstile` esté disponible.
 * - Renderiza el widget en un contenedor OFFSCREEN (Turnstile exige un elemento
 *   montado) y resuelve con el token en el `callback`. error/expired → null.
 * - Timeout de seguridad: nunca cuelga el arranque del mundo (resuelve null).
 * - Los tokens son de UN solo uso: cada llamada renderiza/resuelve de nuevo, sin
 *   cachear el token. Sólo se deduplican llamadas CONCURRENTES (una promesa en
 *   vuelo compartida) para no montar dos widgets a la vez.
 *
 * En SSR / tests (node, sin `window`) o sin site key → resuelve `null` de
 * inmediato, y quien llame decide seguir sin captcha.
 */

const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** Tras este tiempo damos por perdido el reto y resolvemos null (no colgamos). */
const RESOLVE_TIMEOUT_MS = 12_000;
/** Cada cuánto sondeamos que `window.turnstile` ya esté disponible. */
const POLL_INTERVAL_MS = 60;

/** Interfaz local mínima de la API global de Turnstile (misma idea que RegisterModal). */
interface TurnstileRenderOptions {
  sitekey: string;
  callback(token: string): void;
  "error-callback"?(): void;
  "expired-callback"?(): void;
}
interface TurnstileApi {
  render(el: HTMLElement, opts: TurnstileRenderOptions): string;
  remove?(widgetId: string): void;
}
type TurnstileWindow = Window & typeof globalThis & { turnstile?: TurnstileApi };

/** Promesa en vuelo compartida: deduplica llamadas concurrentes (una sola a la vez). */
let inFlight: Promise<string | null> | null = null;

function siteKey(): string | undefined {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}

/**
 * Devuelve un token Turnstile de un solo uso, o `null` si no aplica (sin site
 * key, sin DOM) o si el reto falla / expira / agota el timeout. Nunca rechaza.
 */
export async function getCaptchaToken(): Promise<string | null> {
  // Sin site key, o fuera del navegador (SSR / tests node): no hay captcha.
  if (!siteKey()) return null;
  if (typeof window === "undefined" || typeof document === "undefined") return null;

  // Dedup de llamadas concurrentes: comparten la misma promesa en vuelo.
  if (inFlight) return inFlight;
  inFlight = requestToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Monta un widget offscreen, resuelve con su token (o null) y limpia siempre:
 * quita el widget (`turnstile.remove`) y el contenedor del DOM.
 */
function requestToken(): Promise<string | null> {
  const key = siteKey() as string;

  return new Promise<string | null>((resolve) => {
    // `cancelled` corta el sondeo de `window.turnstile` cuando ya resolvimos.
    const guard = { cancelled: false };
    let settled = false;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;
    let container: HTMLElement | null = null;

    const cleanup = () => {
      if (api && widgetId && typeof api.remove === "function") {
        try {
          api.remove(widgetId);
        } catch {
          /* la API puede no soportar remove en algunos builds: ignoramos */
        }
      }
      if (container?.parentNode) container.parentNode.removeChild(container);
      container = null;
    };

    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      guard.cancelled = true;
      clearTimeout(timer);
      cleanup();
      resolve(token);
    };

    const timer = setTimeout(() => finish(null), RESOLVE_TIMEOUT_MS);

    // Contenedor offscreen: montado pero invisible e inerte (aria-hidden).
    container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    Object.assign(container.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      overflow: "hidden",
      opacity: "0",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(container);

    ensureScript();
    waitForTurnstile(guard).then((resolved) => {
      if (settled) return;
      api = resolved;
      if (!api || !container) {
        finish(null);
        return;
      }
      try {
        widgetId = api.render(container, {
          sitekey: key,
          callback: (token: string) => finish(token),
          "error-callback": () => finish(null),
          "expired-callback": () => finish(null),
        });
      } catch {
        finish(null);
      }
    });
  });
}

/** Inyecta el script de Turnstile UNA vez, reutilizando el id compartido. */
function ensureScript(): void {
  if (document.getElementById(TURNSTILE_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = TURNSTILE_SCRIPT_ID;
  script.src = TURNSTILE_SRC;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

/**
 * Espera (sondeando) a que la API global `window.turnstile` exista. Robusto ante
 * el caso de que el script ya se hubiera cargado antes (no dependemos del evento
 * `load`, que no re-dispara). El timeout externo acota la espera.
 */
function waitForTurnstile(guard: { cancelled: boolean }): Promise<TurnstileApi | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (guard.cancelled) {
        resolve(null);
        return;
      }
      const api = (window as TurnstileWindow).turnstile;
      if (api) {
        resolve(api);
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  });
}
