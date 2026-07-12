const BASE = "https://o.oraculos.app";

/**
 * JSON-LD de datos estructurados (WebSite + VideoGame) para la portada. Server
 * Component: emite un <script type="application/ld+json"> estático. Se monta una
 * vez en el layout raíz.
 */
export function JsonLd() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${BASE}/#website`,
        url: BASE,
        name: "Phygitalia",
        alternateName: "Oráculos Telúrico-Sintéticos",
        description:
          "El mundo 3D de los Oráculos Telúrico-Sintéticos: camina, encuéntrate y consulta a los Oráculos.",
        inLanguage: "es",
      },
      {
        "@type": "VideoGame",
        "@id": `${BASE}/#game`,
        name: "Phygitalia — Oráculos",
        url: BASE,
        description:
          "Una constelación de biósferas 3D multijugador donde caminas, te encuentras y consultas a los Oráculos Telúrico-Sintéticos.",
        inLanguage: "es",
        applicationCategory: "GameApplication",
        operatingSystem: "Web",
        gamePlatform: ["Web browser", "PWA"],
        image: `${BASE}/og.png`,
        creator: [
          { "@type": "Person", name: "Julio Sahagún Sánchez" },
          { "@type": "Person", name: "Tessa Fansa Vega" },
        ],
        offers: { "@type": "Offer", price: "0", priceCurrency: "MXN" },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      // Contenido estático y controlado por nosotros: sin datos de usuario.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
