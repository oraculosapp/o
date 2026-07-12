"use client";

import Link from "next/link";
import { Bell } from "./Bell";
import styles from "./hud-controls.module.css";

/**
 * Grupo de controles del HUD anclado arriba-derecha: campanita de
 * notificaciones + enlace al perfil propio (`/usuario`). Discreto, glass, no
 * estorba el joystick (abajo-izquierda) ni el chat (abajo-izquierda).
 *
 * Pensado para montarse en una línea desde la page de la Biósfera.
 */
export function HudControls() {
  return (
    <div className={styles.cluster}>
      <Bell />
      <Link href="/usuario" className={styles.profileLink} aria-label="Tu perfil" title="Tu perfil">
        <ProfileGlyph />
      </Link>
    </div>
  );
}

/** Glifo de persona/viajero (trazo 1.6px currentColor). */
function ProfileGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5.5 19.5c.7-3.3 3.3-5 6.5-5s5.8 1.7 6.5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
