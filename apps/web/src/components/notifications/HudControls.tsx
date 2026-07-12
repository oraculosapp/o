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
export interface HudControlsProps {
  /** Si se pasa, muestra el botón “Cambiar avatar” junto al clúster. */
  onChangeAvatar?: () => void;
}

export function HudControls({ onChangeAvatar }: HudControlsProps = {}) {
  return (
    <>
      <div className={styles.cluster}>
        <Bell />
        <Link href="/usuario" className={styles.profileLink} aria-label="Tu perfil" title="Tu perfil">
          <ProfileGlyph />
        </Link>
      </div>
      {/* “Cambiar avatar” en su propio slot fijo, a la IZQUIERDA del botón de
          mute (que vive anclado en right:112px y pertenece a audio/). */}
      {onChangeAvatar && (
        <button
          type="button"
          className={`${styles.profileLink} ${styles.avatarSlot}`}
          onClick={onChangeAvatar}
          aria-label="Cambiar avatar"
          title="Cambiar avatar"
        >
          <AvatarGlyph />
        </button>
      )}
    </>
  );
}

/** Glifo de máscara/avatar (busto con antifaz — “cambiar de piel”). */
function AvatarGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20c0-3.6 3.2-6 8-6s8 2.4 8 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.4 7.6h5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
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
