import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phygitalia — El mundo de los Oráculos Telúrico-Sintéticos",
  description:
    "Phygitalia: una constelación de biósferas 3D donde caminas, te encuentras y consultas a los Oráculos Telúrico-Sintéticos.",
  applicationName: "Phygitalia",
  openGraph: {
    title: "Phygitalia",
    description: "El mundo de los Oráculos Telúrico-Sintéticos.",
    locale: "es_ES",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Phygitalia",
    description: "El mundo de los Oráculos Telúrico-Sintéticos.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d16",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
