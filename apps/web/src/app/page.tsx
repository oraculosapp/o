import Link from "next/link";
import SplashCanvas from "./splash-canvas";
import styles from "./page.module.css";

// Splash de o.oraculos.app — la puerta al mundo. Todo el texto es SSR (SEO);
// el diorama 3D se compone encima de la nebulosa y nunca bloquea al botón.
export default function Home() {
  return (
    <main className={styles.hero}>
      {/* Capa 0 — nebulosa cósmica CSS: pinta al instante (<1s), sin JS. */}
      <div className={styles.nebula} aria-hidden />
      <div className={styles.stars} aria-hidden />

      {/* Capa 1 — diorama ceremonial three.js (transparente sobre la nebulosa). */}
      <SplashCanvas />

      {/* Capa 2 — contenido SSR: logotipo, subtítulo y ENTRAR. */}
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
        <Link href="/b/paqo" className={styles.enter}>
          ENTRAR
        </Link>
      </div>

      {/* Viñeta superior para asentar el logo sobre la escena. */}
      <div className={styles.vignette} aria-hidden />
    </main>
  );
}
