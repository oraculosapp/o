import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Cookies",
  description:
    "Phygitalia solo usa almacenamiento esencial: tu sesión y tus preferencias. Sin rastreo ni publicidad.",
  alternates: { canonical: "/cookies" },
  openGraph: {
    title: "Cookies · Phygitalia",
    description: "Solo lo esencial: sesión y preferencias. Sin rastreo.",
    url: "/cookies",
  },
};

export default function CookiesPage() {
  return (
    <LegalPage
      title="Cookies y almacenamiento"
      updated="11 de julio de 2026"
      intro={
        <>
          Buenas noticias: hoy Phygitalia <b>no usa cookies de rastreo ni de publicidad</b>. Solo
          guardamos lo mínimo para que el mundo funcione y recuerde tus preferencias.
        </>
      }
    >
      <h2>Qué guardamos y por qué</h2>
      <ul>
        <li>
          <strong>Tu sesión de acceso</strong>: si creas cuenta, mantiene tu acceso iniciado para
          que no tengas que entrar una y otra vez. Es esencial para el servicio.
        </li>
        <li>
          <strong>Preferencias locales</strong> (localStorage de tu navegador): tu nombre efímero,
          tu avatar elegido, si ya viste este aviso, y ajustes como el silencio. Vive en tu
          dispositivo; no viaja a ningún servidor de publicidad.
        </li>
      </ul>

      <div className="note">
        Como solo usamos almacenamiento <strong>esencial</strong>, no hay nada de rastreo que
        "aceptar o rechazar". Por eso nuestro aviso es informativo, con un simple{" "}
        <strong>Entendido</strong>, en lugar de un muro de opciones.
      </div>

      <h2>Cómo controlarlo</h2>
      <p>
        Puedes borrar este almacenamiento cuando quieras desde los ajustes de tu navegador (borrar
        datos del sitio). Si lo haces, perderás tus preferencias locales y tendrás que volver a
        iniciar sesión.
      </p>

      <h2>Si esto cambia</h2>
      <p>
        Si algún día añadimos algo más que lo esencial (por ejemplo, métricas), actualizaremos esta
        página y te pediremos consentimiento real antes de activarlo.
      </p>

      <h2>Más información</h2>
      <p>
        Revisa también nuestro <a href="/privacidad">aviso de privacidad</a>. ¿Preguntas? Escríbenos
        a <a href="mailto:hola@oraculos.app">hola@oraculos.app</a>.
      </p>
    </LegalPage>
  );
}
