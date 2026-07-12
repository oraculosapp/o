import SplashHome from "./splash-home";
import { InstallButton } from "@/components/pwa/InstallButton";
import { Footer } from "@/components/legal/Footer";
import styles from "./page.module.css";

// Splash de o.oraculos.app — la puerta al mundo. La marca (nebulosa + logotipo +
// footer) es SSR y pinta al instante; la isla interactiva (nick + selector 3D de
// avatar + ENTRAR) hidrata encima. El preview 3D del avatar aparece en fade cuando
// monta y nunca bloquea al campo ni al botón.
export default function Home() {
  return (
    <main className={styles.hero}>
      {/* Capa 0 — nebulosa cósmica CSS: pinta al instante (<1s), sin JS. */}
      <div className={styles.nebula} aria-hidden />
      <div className={styles.stars} aria-hidden />

      {/* Capa 1 — contenido: logotipo, subtítulo, isla interactiva y ENTRAR. */}
      <div className={styles.content}>
        <div className={styles.header}>
          <h1 className={styles.logotype}>
            {/* Logotipo oficial (negro→dorado por filtro CSS). Raw <img> a propósito:
                el filtro invert/sepia va sobre el PNG y no queremos el pipeline de
                next/image aquí. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/oraculos-logotipo.png"
              alt="ORÁCULOS"
              className={styles.logo}
              width={520}
              height={150}
              fetchPriority="high"
            />
          </h1>
          <p className={styles.tagline}>
            PHYGITALIA · El mundo de los Oráculos Telúrico&#8209;Sintéticos
          </p>
        </div>

        {/* Isla interactiva: nickname + selector 3D de avatar + ENTRAR (client). */}
        <SplashHome />

        <div className={styles.tail}>
          <InstallButton />
          <Footer />
        </div>
      </div>

      {/* Viñeta superior para asentar el logo sobre la escena. */}
      <div className={styles.vignette} aria-hidden />
    </main>
  );
}
