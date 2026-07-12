import type { MetadataRoute } from "next";

const BASE = "https://o.oraculos.app";

/**
 * Sitemap de Phygitalia. Indexamos la landing y las páginas legales (públicas y
 * estables). Se excluyen a propósito: /usuario, /dev/* y las APIs (ver robots.ts).
 * Los perfiles públicos /u/[handle] son dinámicos y quedan indexables sin listarse
 * aquí (se descubren por enlaces).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${BASE}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/terminos`, lastModified, changeFrequency: "yearly", priority: 0.4 },
    { url: `${BASE}/privacidad`, lastModified, changeFrequency: "yearly", priority: 0.4 },
    { url: `${BASE}/cookies`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
