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
 * - Renderiza el widget con `appearance: "interaction-only"` en un contenedor
 *   REAL (fijo, centrado abajo) que permanece INVISIBLE mientras Cloudflare no
 *   exija interacción. Los widgets "Managed" de CF a veces piden un reto
 *   interactivo; con el viejo contenedor offscreen de 0×0 era IMPOSIBLE
 *   completarlo → el token nunca llegaba → el usuario caía en `captcha_failed` y
 *   quedaba invisible en multijugador. Ahora, cuando CF entra en modo
 *   interactivo (`before-interactive-callback`), revelamos un marco glass de la
 *   casa con la leyenda "Verificando que eres viajero…" para que el viajero
 *   PUEDA resolver el reto. Al obtener el token (o fallar) se limpia todo.
 * - Timeout de seguridad más holgado (25 s): los retos interactivos tardan;
 *   nunca cuelga el arranque del mundo (resuelve null).
 * - Los tokens son de UN solo uso: cada llamada renderiza/resuelve de nuevo, sin
 *   cachear el token. Sólo se deduplican llamadas CONCURRENTES (una promesa en
 *   vuelo compartida) para no montar dos widgets a la vez.
 *
 * En SSR / tests (node, sin `window`) o sin site key → resuelve `null` de
 * inmediato, y quien llame decide seguir sin captcha.
 */

const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/**
 * Tras este tiempo damos por perdido el reto y resolvemos null (no colgamos).
 * Holgado (25 s) porque un reto INTERACTIVO "Managed" puede tardar: el usuario
 * necesita ver el marco, leerlo y completar el desafío de Cloudflare.
 */
const RESOLVE_TIMEOUT_MS = 25_000;
/** Cada cuánto sondeamos que `window.turnstile` ya esté disponible. */
const POLL_INTERVAL_MS = 60;

/** Interfaz local mínima de la API global de Turnstile (misma idea que RegisterModal). */
interface TurnstileRenderOptions {
  sitekey: string;
  callback(token: string): void;
  "error-callback"?(): void;
  "expired-callback"?(): void;
  "timeout-callback"?(): void;
  /** CF va a entrar en modo interactivo (pedirá una acción al usuario). */
  "before-interactive-callback"?(): void;
  /** CF terminó el tramo interactivo. */
  "after-interactive-callback"?(): void;
  /**
   * "interaction-only": el widget queda INVISIBLE salvo que CF exija interacción
   * (justo lo que un widget "Managed" hace); entonces se muestra sólo el reto.
   */
  appearance?: "always" | "execute" | "interaction-only";
  theme?: "auto" | "light" | "dark";
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
 * Monta el widget en un contenedor REAL (invisible hasta que CF pida interacción),
 * resuelve con su token (o null) y limpia siempre: quita el widget
 * (`turnstile.remove`) y el contenedor del DOM.
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
    let mount: HTMLElement | null = null;

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
      mount = null;
    };

    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      guard.cancelled = true;
      clearTimeout(timer);
      cleanup();
      resolve(token);
    };

    /**
     * Revela el marco glass cuando CF entra en modo interactivo: hasta aquí el
     * contenedor estaba montado pero invisible e inerte. Ahora el viajero PUEDE
     * ver y completar el reto.
     */
    const reveal = () => {
      if (settled || !container) return;
      container.setAttribute("aria-hidden", "false");
      container.style.opacity = "1";
      container.style.pointerEvents = "auto";
      container.style.transform = "translateX(-50%) translateY(0)";
    };

    const timer = setTimeout(() => finish(null), RESOLVE_TIMEOUT_MS);

    // --- Contenedor real, fijo y centrado abajo, oculto hasta que haga falta ---
    // Respeta safe-areas y se sitúa POR ENCIMA de los mandos (joystick a la izq.,
    // botones a la der., launcher de chat abajo): bottom = 96px + safe-area.
    container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    Object.assign(container.style, {
      position: "fixed",
      left: "50%",
      bottom: "calc(96px + env(safe-area-inset-bottom))",
      transform: "translateX(-50%) translateY(8px)",
      zIndex: "90",
      maxWidth: "min(340px, calc(100vw - 24px))",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      opacity: "0",
      pointerEvents: "none",
      transition:
        "opacity 160ms cubic-bezier(0.22,0.61,0.36,1), transform 160ms cubic-bezier(0.22,0.61,0.36,1)",
    } satisfies Partial<CSSStyleDeclaration>);

    // Marco glass discreto de la casa (tokens de marca con fallback literal por si
    // el CSS de tokens aún no cargó cuando se monta este nodo suelto en <body>).
    const frame = document.createElement("div");
    Object.assign(frame.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "10px",
      padding: "12px 14px",
      border: "1px solid var(--line, rgba(227,176,99,0.16))",
      borderRadius: "var(--radius, 16px)",
      background: "var(--panel-hud, rgba(16,18,29,0.92))",
      boxShadow: "var(--shadow, 0 18px 50px -18px rgba(0,0,0,0.7))",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.style.setProperty("backdrop-filter", "blur(8px)");
    frame.style.setProperty("-webkit-backdrop-filter", "blur(8px)");

    // Leyenda: Chakra Petch (display), dorado de la casa.
    const legend = document.createElement("span");
    legend.textContent = "Verificando que eres viajero…";
    Object.assign(legend.style, {
      fontFamily: 'var(--font-display, "Chakra Petch", ui-monospace, monospace)',
      fontSize: "0.72rem",
      lineHeight: "1.2",
      letterSpacing: "0.06em",
      color: "var(--gold-bright, #f6dca0)",
      textAlign: "center",
    } satisfies Partial<CSSStyleDeclaration>);

    // Punto de montaje REAL del widget de Turnstile (CF inyecta aquí su iframe).
    mount = document.createElement("div");

    frame.appendChild(legend);
    frame.appendChild(mount);
    container.appendChild(frame);
    document.body.appendChild(container);

    ensureScript();
    waitForTurnstile(guard).then((resolved) => {
      if (settled) return;
      api = resolved;
      if (!api || !mount) {
        finish(null);
        return;
      }
      try {
        widgetId = api.render(mount, {
          sitekey: key,
          // "Managed" invisible por defecto: sólo aparece si CF exige interacción.
          appearance: "interaction-only",
          theme: "dark",
          callback: (token: string) => finish(token),
          "error-callback": () => finish(null),
          "expired-callback": () => finish(null),
          "timeout-callback": () => finish(null),
          // Cuando el reto se vuelve interactivo, mostramos el marco para que el
          // usuario lo pueda completar (este era justo el caso roto en prod).
          "before-interactive-callback": () => reveal(),
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
