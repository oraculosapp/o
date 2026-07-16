import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacidad",
  description:
    "Cómo cuidamos tus datos en Phygitalia: qué guardamos, dónde vive, y tus derechos. Sin venta de datos.",
  alternates: { canonical: "/privacidad" },
  openGraph: {
    title: "Privacidad · Phygitalia",
    description: "Cómo cuidamos tus datos en el mundo de los Oráculos.",
    url: "/privacidad",
  },
};

export default function PrivacidadPage() {
  return (
    <LegalPage
      title="Aviso de privacidad"
      updated="16 de julio de 2026"
      intro={
        <>
          En Phygitalia queremos que explorar el mundo de los Oráculos se sienta seguro. Aquí te
          contamos, en <b>palabras claras</b>, qué datos usamos y por qué. Regla de oro:{" "}
          <b>nunca vendemos tu información</b>.
        </>
      }
    >
      <h2>Qué datos guardamos</h2>
      <ul>
        <li>
          <strong>Tu correo</strong>, solo si decides crear cuenta: lo usamos para enviarte el
          enlace mágico de acceso (magic link). Nada de contraseñas.
        </li>
        <li>
          <strong>Tu perfil</strong> (opcional): nombre visible, bio, sitio web y redes. Tu fecha
          de nacimiento y ubicación son opcionales y tú decides, con un interruptor, si cada una es
          pública o privada.
        </li>
        <li>
          <strong>Mensajes del chat público</strong> de cada Biósfera: son parte de la experiencia
          compartida y quedan visibles para quienes estén ahí.
        </li>
        <li>
          <strong>Tus conversaciones con los Oráculos</strong>: si tienes cuenta, guardamos tus
          charlas y un resumen para que el Oráculo <b>te recuerde</b> entre visitas. Sin cuenta,
          la conversación es efímera y no se guarda.
        </li>
        <li>
          <strong>Datos técnicos mínimos</strong>: lo indispensable para que el servicio funcione y
          para frenar abuso (por ejemplo, límites por sesión). Nada de perfiles publicitarios.
        </li>
      </ul>

      <h2>Dónde vive tu información</h2>
      <p>
        Nos apoyamos en proveedores de confianza para operar: <strong>Supabase</strong> (base de
        datos y cuentas), <strong>Vercel</strong> (alojamiento del sitio), <strong>OpenAI</strong>{" "}
        (generación de las respuestas de los Oráculos) y <strong>Cloudflare</strong> (verificación
        anti-abuso, ver más abajo). Cada uno procesa únicamente lo necesario para su función.{" "}
        <b>No vendemos ni comerciamos con tus datos.</b>
      </p>

      <h2>Verificación anti-abuso (Cloudflare Turnstile)</h2>
      <p>
        Para frenar bots y proteger el mundo, al iniciar sesión usamos{" "}
        <strong>Cloudflare Turnstile</strong>, un servicio que verifica que eres una persona real{" "}
        <b>sin resolver captchas molestos</b> y, en modo invisible, sin que aparezca nada en
        pantalla. Para ello Cloudflare puede procesar datos técnicos mínimos de tu navegador. No lo
        usamos para publicidad ni para seguirte por la web. Al usar Phygitalia, este tratamiento se
        rige por la{" "}
        <a
          href="https://www.cloudflare.com/turnstile-privacy-policy/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Adenda de Privacidad de Turnstile de Cloudflare
        </a>
        .
      </p>

      <div className="note">
        <strong>Transparencia sobre la IA.</strong> Las respuestas de los Oráculos las genera
        inteligencia artificial. Son personajes: pueden equivocarse o inventar. Disfrútalos como
        parte de la obra, no como fuente de verdad ni consejo profesional.
      </div>

      <h2>Tus derechos</h2>
      <p>
        Puedes pedir <strong>acceder</strong> a tus datos, <strong>rectificarlos</strong> o{" "}
        <strong>borrarlos</strong>. Escríbenos y lo resolvemos: <a href="mailto:hola@oraculos.app">hola@oraculos.app</a>.
        Si borras tu cuenta, eliminamos tu perfil y tus conversaciones privadas con los Oráculos.
      </p>

      <h2>Menores de edad</h2>
      <p>
        Phygitalia está pensado para personas de <strong>13 años en adelante</strong>. Si crees que
        un menor nos dejó datos sin permiso de su madre, padre o tutor, avísanos y los quitamos.
      </p>

      <h2>Cambios</h2>
      <p>
        Esto es una beta viva. Si actualizamos este aviso, cambiaremos la fecha de arriba y, si el
        cambio es importante, te lo haremos notar dentro del mundo.
      </p>
    </LegalPage>
  );
}
