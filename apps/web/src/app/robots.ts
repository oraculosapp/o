import type { MetadataRoute } from "next";

const BASE = "https://o.oraculos.app";

/**
 * robots.txt de Phygitalia. Indexable: /, legales y perfiles públicos /u/*.
 * Fuera del índice: /usuario (privado), /dev/* (laboratorio) y /api/*.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/usuario", "/dev/", "/api/"],
    },
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
