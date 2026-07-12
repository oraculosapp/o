"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./legal.module.css";

const ACK_KEY = "phy-cookie-ack";

/**
 * Banner de cookies mínimo, estilo "selbar" (píldora glass flotante). Hoy solo
 * usamos almacenamiento esencial (sesión Supabase + preferencias en
 * localStorage), así que es INFORMATIVO: un único botón "Entendido", sin muro y
 * sin toggles de consentimiento que no aplican. Enlaza a /cookies.
 *
 * Recuerda la aceptación en localStorage. Se monta una vez en el layout.
 */
export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(ACK_KEY)) setVisible(true);
    } catch {
      // Sin localStorage (modo privado estricto): no insistimos.
    }
  }, []);

  if (!visible) return null;

  const accept = () => {
    try {
      localStorage.setItem(ACK_KEY, "1");
    } catch {
      /* noop */
    }
    setVisible(false);
  };

  return (
    <div className={styles.cookieBar} role="region" aria-label="Aviso de cookies">
      <p className={styles.cookieText}>
        Usamos solo lo esencial para que el mundo funcione: tu sesión y tus preferencias. Sin
        rastreo ni publicidad.{" "}
        <Link href="/cookies" className={styles.cookieLink}>
          Saber más
        </Link>
      </p>
      <button type="button" className={styles.cookieBtn} onClick={accept}>
        Entendido
      </button>
    </div>
  );
}
