import type { Metadata } from "next";
import { UsuarioClient } from "@/components/profile/UsuarioClient";

// Edición del perfil propio. La sesión vive en el cliente (localStorage), así que
// el shell es server (metadata) y el formulario carga los datos en el cliente.
export const metadata: Metadata = {
  title: "Tu perfil — Phygitalia",
  description: "Edita tu perfil de Phygitalia: handle, bio, redes y privacidad.",
  robots: { index: false, follow: false },
};

export default function UsuarioPage() {
  return (
    <main>
      <UsuarioClient />
    </main>
  );
}
