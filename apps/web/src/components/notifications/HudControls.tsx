"use client";

import { useEffect, useState } from "react";
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
  /** Miniatura del avatar actual (retrato) para el botón "Cambiar avatar". */
  avatarThumbUrl?: string | null;
  /** Color de tinte del avatar (disco dummy si aún no hay retrato). */
  avatarTint?: string | null;
}

export function HudControls({
  onChangeAvatar,
  avatarThumbUrl,
  avatarTint,
}: HudControlsProps = {}) {
  return (
    <>
      <div className={styles.cluster}>
        <Bell />
        {/* "Perfil": silueta genérica de persona. */}
        <Link
          href="/usuario"
          className={`${styles.profileLink} ${styles.tip}`}
          aria-label="Tu perfil"
          data-tip="Tu perfil"
        >
          <ProfileGlyph />
        </Link>
      </div>
      {/* “Cambiar avatar” en su propio slot fijo, a la IZQUIERDA del botón de
          mute (que vive anclado en right:112px y pertenece a audio/). Muestra el
          RETRATO del avatar actual (o su tinte) para distinguirlo del "Perfil". */}
      {onChangeAvatar && (
        <button
          type="button"
          className={`${styles.profileLink} ${styles.avatarSlot} ${styles.tip} ${styles.avatarButton}`}
          onClick={onChangeAvatar}
          aria-label="Cambiar avatar"
          data-tip="Cambiar avatar"
        >
          <AvatarPortrait thumbUrl={avatarThumbUrl} tint={avatarTint} />
        </button>
      )}
    </>
  );
}

/**
 * Retrato circular del avatar actual: la miniatura del arquetipo elegido; si no
 * carga (o aún no hay elección), un disco con el tinte del viajero (dummy). Así
 * este botón NO se confunde con la silueta genérica de "Perfil".
 */
function AvatarPortrait({ thumbUrl, tint }: { thumbUrl?: string | null; tint?: string | null }) {
  const [broken, setBroken] = useState(false);

  // Si cambia la miniatura, reintenta cargarla.
  useEffect(() => {
    setBroken(false);
  }, [thumbUrl]);

  if (thumbUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={thumbUrl}
        alt=""
        aria-hidden
        className={styles.avatarPortrait}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className={styles.avatarDummy}
      aria-hidden
      style={tint ? { background: tint } : undefined}
    />
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
