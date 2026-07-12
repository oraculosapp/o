import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Términos",
  description:
    "Las reglas para convivir en Phygitalia: respeto en el chat, edad mínima, y qué esperar de una beta experimental.",
  alternates: { canonical: "/terminos" },
  openGraph: {
    title: "Términos · Phygitalia",
    description: "Las reglas para convivir en el mundo de los Oráculos.",
    url: "/terminos",
  },
};

export default function TerminosPage() {
  return (
    <LegalPage
      title="Términos de uso"
      updated="11 de julio de 2026"
      intro={
        <>
          Phygitalia es un espacio para encontrarse y jugar con los Oráculos Telúrico-Sintéticos.
          Estas son las reglas mínimas para que sea un buen lugar para todas y todos. Al entrar,{" "}
          <b>las aceptas</b>.
        </>
      }
    >
      <h2>Convivencia y uso aceptable</h2>
      <p>
        Trata a las demás personas con <strong>respeto</strong>. No se permite acoso, discurso de
        odio, amenazas, spam, contenido sexual explícito, ni nada que dañe o incomode a otras
        personas. El chat público es un espacio compartido: cuídalo.
      </p>
      <p>
        Nos reservamos el derecho de <strong>moderar, ocultar o retirar</strong> contenido y de{" "}
        <strong>suspender el acceso</strong> a quien rompa estas reglas, para proteger a la
        comunidad.
      </p>

      <h2>Edad mínima</h2>
      <p>
        Debes tener al menos <strong>13 años</strong> para usar Phygitalia.
      </p>

      <h2>Servicio experimental (beta)</h2>
      <div className="note">
        Esto es una <strong>beta</strong>: habrá fallos, cambios y pausas. El servicio se ofrece
        "tal cual", sin garantías de disponibilidad continua. Guarda cariño, no expectativas de
        producto terminado.
      </div>

      <h2>Los Oráculos son IA</h2>
      <p>
        Las respuestas de los Oráculos las genera inteligencia artificial. Son personajes de la
        obra: pueden equivocarse o inventar. <strong>No</strong> son consejo médico, legal,
        financiero ni de ningún tipo profesional.
      </p>

      <h2>Propiedad intelectual</h2>
      <p>
        El mundo de los Oráculos Telúrico-Sintéticos —personajes, lore, arte, textos y diseño— es
        una obra de <strong>Julio Sahagún Sánchez</strong> y <strong>Tessa Fansa Vega</strong>, y
        está protegida. Puedes disfrutarla y compartir capturas de tu experiencia, pero no
        reproducir ni explotar comercialmente la obra sin permiso.
      </p>
      <p>
        Lo que tú escribes en el chat sigue siendo tuyo; al publicarlo nos das permiso para
        mostrarlo dentro del servicio como parte de la experiencia compartida.
      </p>

      <h2>Limitación de responsabilidad</h2>
      <p>
        En la medida en que la ley lo permita, no nos hacemos responsables por daños derivados del
        uso de una experiencia beta y gratuita. Usa Phygitalia con sentido común y buena onda.
      </p>

      <h2>Contacto</h2>
      <p>
        ¿Dudas o reportes? Escríbenos a <a href="mailto:hola@oraculos.app">hola@oraculos.app</a>.
      </p>
    </LegalPage>
  );
}
