import Link from "next/link";
import styles from "./page.module.css";

// Landing SSR de marca — fricción cero: un botón ENTRAR hacia la biósfera Paqo.
export default function Home() {
  return (
    <main className={styles.hero}>
      <div className={styles.nebula} aria-hidden />
      <div className={styles.inner}>
        <h1 className={styles.logotype}>PHYGITALIA</h1>
        <p className={styles.tagline}>El mundo de los Oráculos Telúrico-Sintéticos</p>
        <Link href="/b/paqo" className={styles.enter}>
          ENTRAR
        </Link>
      </div>
    </main>
  );
}
