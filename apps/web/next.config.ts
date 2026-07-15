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
 *   · `worker-src`/`child-src` blob: — three carga workers de decodificación.
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

const scriptSrc = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", isDev ? "'unsafe-eval'" : ""]
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
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()",
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
