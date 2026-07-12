import type { Metadata } from "next";
import { UsuarioClient } from "@/components/profile/UsuarioClient";
import { InstallButton } from "@/components/pwa/InstallButton";
import { Footer } from "@/components/legal/Footer";

// Edición del perfil propio. La sesión vive en el cliente (localStorage), así que
// el shell es server (metadata) y el formulario carga los datos en el cliente.
export const metadata: Metadata = {
  title: "Tu perfil",
  description: "Edita tu perfil de Phygitalia: handle, bio, redes y privacidad.",
  robots: { index: false, follow: false },
};

export default function UsuarioPage() {
  return (
    <main>
      <UsuarioClient />
      <div style={{ display: "grid", placeItems: "center", gap: "1.2rem", padding: "0 1rem 2rem" }}>
        <InstallButton />
        <Footer />
      </div>
    </main>
  );
}
