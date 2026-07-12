"use client";

import { useEffect, useState } from "react";
import { Bell } from "./Bell";
import { AccountFab } from "./AccountFab";
import styles from "./hud-controls.module.css";

/**
 * Grupo de controles del HUD anclado arriba-IZQUIERDA (sobre el viewport del
 * juego, NO sobre la columna del chat de la derecha): campanita de
 * notificaciones + FAB de cuenta (crear cuenta / entrar / perfil / cerrar
 * sesión). Forma fila con "Instalar app", mute y el retrato de avatar. Discreto,
 * glass, no estorba el joystick (abajo-izquierda) ni la columna del chat.
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
        {/* FAB de cuenta: menú con crear cuenta / entrar / perfil / cerrar sesión. */}
        <AccountFab />
      </div>
      {/* “Cambiar avatar” en su propio slot fijo dentro del clúster superior-
          izquierda (left:116, entre el mute y la campanita+cuenta). Muestra el
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
