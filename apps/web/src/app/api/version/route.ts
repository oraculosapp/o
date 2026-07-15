/**
 * GET /api/version — beacon del build vivo.
 *
 * Devuelve el build id del despliegue que está sirviendo AHORA MISMO, sin caché.
 * El cliente (`UpdateSentinel`) compara este valor contra el id que lleva
 * embebido en su bundle; si difieren, está corriendo código viejo (pestaña/PWA
 * abierta desde antes de un deploy) y debe recargar.
 *
 * · `force-dynamic` + `Cache-Control: no-store` → la respuesta NUNCA se cachea
 *   (ni en el edge de Vercel, ni en el navegador, ni en el Service Worker, que
 *   además ignora /api/* por diseño). Cada petición refleja el deploy actual.
 * · El build id se inyecta en build desde `next.config.ts` (env
 *   NEXT_PUBLIC_BUILD_ID). En dev cae a un placeholder estable.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

export function GET(): Response {
  return new Response(JSON.stringify({ v: BUILD_ID }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
