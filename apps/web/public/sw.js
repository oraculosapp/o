/*
 * Service Worker de Phygitalia — o.oraculos.app
 *
 * Filosofía para una app 3D pesada: NO tocar el JS/CSS de Next. Sus chunks ya
 * llevan hash inmutable y cabeceras de caché HTTP correctas; interceptarlos solo
 * añade riesgo (chunks obsoletos, HMR roto). El SW se ocupa de:
 *
 *   1. Assets pesados versionados (/assets, /draco, /fonts, /icons, /runa, logo):
 *      cache-first. Son los GLB/Draco/fuentes que dominan el peso de carga.
 *   2. Navegaciones (documentos HTML): network-first con fallback a /offline.html
 *      si no hay red — la landing sigue "existiendo" sin conexión.
 *
 * El versionado es el nombre de caché: al desplegar un SW nuevo, `activate`
 * borra las cachés viejas y los assets se re-piden frescos.
 */

const VERSION = "phy-v3"; // v3: iconos nuevos de Paqo (los /icons/ son cache-first)
const RUNTIME = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/offline.html";

// Precache mínimo: la página offline y la marca que la viste.
const PRECACHE = [OFFLINE_URL, "/runa.png", "/oraculos-logotipo.png", "/icons/icon-192.png"];

// Rutas de assets cacheables (cache-first). Mismo origen únicamente.
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/draco/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/runa.png" ||
    url.pathname === "/oraculos-logotipo.png" ||
    url.pathname === "/og.png"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== RUNTIME && key !== SHELL).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Solo mismo origen. Terceros (Supabase, OpenAI, etc.) van directos a red.
  if (url.origin !== self.location.origin) return;

  // NUNCA interceptar el pipeline de Next ni las APIs: que Next/HTTP manden.
  if (url.pathname.startsWith("/_next/") || url.pathname.startsWith("/api/")) return;

  // Navegaciones (documentos): network-first, fallback offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL, { ignoreSearch: true })),
    );
    return;
  }

  // Assets pesados versionados: cache-first con relleno perezoso.
  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Solo cachear respuestas OK básicas (evita opacas/errores).
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(RUNTIME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});

// Permite a la página forzar la activación inmediata de un SW nuevo.
// Acepta tanto el string legado "SKIP_WAITING" como el objeto { type: "SKIP_WAITING" }
// (forma que emite el flujo de actualización moderno; ver ServiceWorkerRegister).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});
