import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "./Footer";
import styles from "./legal.module.css";

/**
 * Shell de las páginas legales (/privacidad, /terminos, /cookies): fondo cósmico,
 * panel glass, cabecera Chakra Petch y footer de marca. Server Component.
 *
 * El envoltorio flex es un <div> (solo layout); el contenido legal en sí vive en
 * <main> y el <Footer/> queda fuera de él, como hermano — así <main> delimita
 * únicamente el contenido principal de la página (landmarks correctos para
 * lectores de pantalla: <footer> no debe anidarse dentro de <main>).
 */
export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.main}>
      <div className={styles.nebula} aria-hidden />

      <main>
        <article className={styles.card}>
          <header className={styles.head}>
            <Link href="/" className={styles.back}>
              ← Phygitalia
            </Link>
            <p className={styles.updated}>Actualizado · {updated}</p>
          </header>

          <h1 className={styles.title}>{title}</h1>
          {intro && <div className={styles.intro}>{intro}</div>}

          <div className={styles.body}>{children}</div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
