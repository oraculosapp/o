import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { UpdateSentinel } from "@/components/pwa/UpdateSentinel";
import { CookieBanner } from "@/components/legal/CookieBanner";
import { JsonLd } from "@/components/seo/JsonLd";

export const metadata: Metadata = {
  metadataBase: new URL("https://o.oraculos.app"),
  title: {
    default: "Phygitalia — El mundo de los Oráculos Telúrico-Sintéticos",
    template: "%s · Phygitalia",
  },
  description:
    "Phygitalia: una constelación de biósferas 3D donde caminas, te encuentras y consultas a los Oráculos Telúrico-Sintéticos.",
  applicationName: "Phygitalia",
  manifest: "/manifest.json",
  alternates: { canonical: "/" },
  appleWebApp: {
    capable: true,
    title: "Phygitalia",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/favicon.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "Phygitalia — El mundo de los Oráculos Telúrico-Sintéticos",
    description: "El mundo 3D de los Oráculos Telúrico-Sintéticos.",
    url: "/",
    siteName: "Phygitalia",
    locale: "es_ES",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Phygitalia — Oráculos Telúrico-Sintéticos",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Phygitalia — El mundo de los Oráculos Telúrico-Sintéticos",
    description: "El mundo 3D de los Oráculos Telúrico-Sintéticos.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d16",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // El teclado virtual REDIMENSIONA el layout (no lo tapa): así el composer del
  // chat queda siempre por encima del teclado y las alturas en `dvh` se ajustan a
  // la ventana visible. Base del arreglo "el teclado tapa el chat" en móvil.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        {children}
        <CookieBanner />
        <ServiceWorkerRegister />
        <UpdateSentinel />
        <JsonLd />
      </body>
    </html>
  );
}
