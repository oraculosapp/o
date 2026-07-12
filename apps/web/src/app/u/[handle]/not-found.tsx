import Link from "next/link";
import styles from "./u.module.css";

// 404 digno cuando el handle no corresponde a ningún perfil público.
export default function ProfileNotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.nebula} aria-hidden />
      <article className={styles.card}>
        <header className={styles.head}>
          <span className={styles.avatar} aria-hidden>
            ?
          </span>
          <h1 className={styles.handle}>Nadie por aquí</h1>
        </header>
        <p className={styles.bio}>
          Este handle no pertenece a ningún viajero de Phygitalia. Puede que haya cambiado de
          nombre, o que la niebla lo esté ocultando.
        </p>
        <footer className={styles.foot}>
          <Link href="/b/paqo" className={styles.enter}>
            Entrar a Phygitalia
          </Link>
        </footer>
      </article>
    </main>
  );
}
