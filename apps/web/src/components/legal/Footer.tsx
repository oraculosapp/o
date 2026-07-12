import Link from "next/link";
import styles from "./legal.module.css";

/**
 * Footer ligero de marca: los tres enlaces legales + créditos. Se monta en la
 * landing y en las páginas legales. Server Component, sin estado.
 */
export function Footer() {
  return (
    <footer className={styles.footer}>
      <nav className={styles.footerLinks} aria-label="Legal">
        <Link href="/terminos" className={styles.footerLink}>
          Términos
        </Link>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        <Link href="/privacidad" className={styles.footerLink}>
          Privacidad
        </Link>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        <Link href="/cookies" className={styles.footerLink}>
          Cookies
        </Link>
      </nav>
      <p className={styles.credits}>
        Creado por Julio Sahagún Sánchez, Tessa Fansa Vega, GrimorIA y Claude.
      </p>
    </footer>
  );
}
