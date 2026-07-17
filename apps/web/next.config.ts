import type { NextConfig } from "next";

/**
 * Cabeceras de seguridad (M-2).
 *
 * CSP pensada para una app Next 15 + three.js (+ DRACO/meshopt wasm) + Supabase
 * Realtime + canvas:
 *   · `script-src`: 'self' + 'unsafe-inline' (Next inyecta scripts inline de
 *     hidratación) + 'wasm-unsafe-eval' (los decoders wasm de three/DRACO/meshopt
 *     lo necesitan). En desarrollo añadimos 'unsafe-eval' porque el Fast Refresh
 *     de React usa eval; en producción NO, para no debilitar la política.
 *   · `script-src` incluye https://challenges.cloudflare.com — el script de
 *     Cloudflare Turnstile (turnstile/v0/api.js). OJO — regresión ya vivida (S4d
 *     endureció la CSP y rompió Turnstile EN SILENCIO): sin él, script-src-elem
 *     bloquea el script, getCaptchaToken() agota sus 25s y resuelve null,
 *     signInAnonymously va sin captchaToken y Supabase responde 400 "captcha
 *     protection: request disallowed" → sin sesión anónima → SIN multijugador ni
 *     voz para todo visitante nuevo. Los visitantes con sesión persistida no lo
 *     notaban, por eso pasó desapercibido.
 *   · `frame-src` explícita — el widget de Turnstile monta un IFRAME de
 *     challenges.cloudflare.com; sin frame-src el navegador cae a child-src
 *     ('self' blob:) y también lo bloquea. Según la doc oficial de Turnstile,
 *     con script-src + frame-src basta (el style-src inline ya lo tenemos).
 *   · `worker-src`/`child-src` blob: — three carga workers de decodificación.
 *     child-src se conserva tal cual para los workers; frame-src la puentea
 *     para los iframes.
 *   · `img-src` data: blob: — texturas de canvas, miniaturas y thumbs de avatar.
 *   · `connect-src`: same-origin (la API de OpenAI se llama server-side vía /api)
 *     + Supabase (https REST/Storage y wss Realtime). Cubre el EventSource SSE de
 *     /api/oracle (same-origin) y el canal Realtime.
 *   · `frame-ancestors 'none'` — refuerza X-Frame-Options: DENY (anti-clickjacking).
 *   · `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
 */
const isDev = process.env.NODE_ENV !== "production";

/**
 * Build id del despliegue — la "huella" del código que se está sirviendo.
 *
 * Se resuelve UNA vez, en build, y se usa en dos sitios que DEBEN coincidir:
 *   1. `generateBuildId` → el propio build id interno de Next.
 *   2. `env.NEXT_PUBLIC_BUILD_ID` → inyectado (inline) en el bundle del cliente
 *      Y legible en el server por `/api/version`.
 *
 * Así el cliente lleva su id embebido y `/api/version` sirve el del deploy vivo;
 * `UpdateSentinel` los compara para saber si la pestaña corre código viejo.
 *
 * Prioridad: override explícito → SHA del commit en Vercel → sello temporal
 * (builds locales). Nunca vacío.
 */
const BUILD_ID =
  process.env.NEXT_PUBLIC_BUILD_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
  `local-${Date.now()}`;

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  // Turnstile: el script del captcha se sirve desde challenges.cloudflare.com.
  "https://challenges.cloudflare.com",
  isDev ? "'unsafe-eval'" : "",
]
  .filter(Boolean)
  .join(" ");

const csp = [
  "default-src 'self'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // Turnstile: el widget monta un iframe de challenges.cloudflare.com; explícita
  // para que los iframes no caigan a child-src (que queda como está, para workers).
  "frame-src 'self' blob: https://challenges.cloudflare.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
]
  .join("; ")
  .concat(isDev ? "" : "; upgrade-insecure-requests");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Permissions-Policy: apagamos todo lo que no usamos… salvo el MICRÓFONO, que
    // la voz WebRTC P2P (S11) necesita en same-origin. `microphone=(self)` lo
    // permite SÓLO a nuestro propio origen (no a iframes de terceros).
    // OJO — regresión ya vivida: con `microphone=()` la Permissions API reportaba
    // "denied" y useVoiceRoom cortaba con "Necesito permiso del micrófono…" SIN
    // llegar a pedirlo, aunque el usuario lo hubiera concedido en el candado 🔒 de
    // Chrome. La cabecera bloquea la feature entera, no es el permiso del usuario.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), browsing-topics=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // El engine y demás paquetes internos se distribuyen como TS puro:
  // Next los transpila en vez de consumir un build propio.
  transpilePackages: ["@phygitalia/engine", "@phygitalia/ui", "@phygitalia/content"],
  // El build id de Next = nuestra huella de deploy, para que el nombre de los
  // artefactos y el beacon de versión hablen del mismo despliegue.
  generateBuildId: async () => BUILD_ID,
  // Inyecta el build id como env pública: inline en el bundle del cliente
  // (id embebido de UpdateSentinel) y legible en el server (/api/version).
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
