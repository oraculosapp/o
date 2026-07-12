import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "./Footer";
import styles from "./legal.module.css";

/**
 * Shell de las páginas legales (/privacidad, /terminos, /cookies): fondo cósmico,
 * panel glass, cabecera Chakra Petch y footer de marca. Server Component.
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
    <main className={styles.main}>
      <div className={styles.nebula} aria-hidden />

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

      <Footer />
    </main>
  );
}
