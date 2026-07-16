"use client";

import { useEffect, useState } from "react";
import { Bell } from "./Bell";
import { AccountFab } from "./AccountFab";
import styles from "./hud-controls.module.css";

/**
 * Aporta los 3 PRIMEROS controles del MENÚ superior, como HERMANOS de fragmento
 * (sin wrapper de posición) para que sean hijos flex directos del `<nav>` del menú
 * en el orden pedido: (1) editar avatar, (2) perfil/cuenta (AccountFab) y
 * (3) notificaciones (Bell). El menú los alinea y hace wrap automáticamente; cada
 * botón ya sólo aporta su forma (glass, redondo). Los demás controles (ánimo/clima,
 * sonido, chat, juego) los montan otros componentes como hermanos flex siguientes.
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
      {/* (1) “Editar avatar”: PRIMER control del menú. Muestra el RETRATO del avatar
          actual (o su tinte) para distinguirlo del "Perfil". */}
      {onChangeAvatar && (
        <button
          type="button"
          className={`${styles.profileLink} ${styles.tip} ${styles.avatarButton}`}
          onClick={onChangeAvatar}
          aria-label="Cambiar avatar"
          data-tip="Cambiar avatar"
        >
          <AvatarPortrait thumbUrl={avatarThumbUrl} tint={avatarTint} />
        </button>
      )}
      {/* (2) perfil/cuenta, luego (3) notificaciones — hermanos flex directos. */}
      <AccountFab />
      <Bell />
    </>
  );
}

/**
 * Retrato circular del avatar actual: la miniatura "nube" TEÑIDA con el color
 * elegido del viajero, para que el iconito muestre TU color (igual que el avatar
 * en el mundo) y NO se confunda con la silueta genérica de "Perfil".
 *
 * El tinte se aplica en vivo: `tint` es el color ACTUAL (page.tsx pasa
 * `avatarSel.color` del store {design, color}; al aplicar un color nuevo en el
 * picker, `onApplyAvatar` re-renderiza y el retrato se re-tiñe solo).
 *
 * Técnica: la miniatura es una figura casi-blanca sobre fondo blanco (sin alfa),
 * así que una capa de color en `mix-blend-mode: multiply` sobre la imagen la
 * recolorea conservando su forma/sombreado (blanco×color = color; sombras×color =
 * color más oscuro). Si la imagen no carga, cae a un disco liso con el tinte.
 */
function AvatarPortrait({ thumbUrl, tint }: { thumbUrl?: string | null; tint?: string | null }) {
  const [broken, setBroken] = useState(false);

  // Si cambia la miniatura, reintenta cargarla.
  useEffect(() => {
    setBroken(false);
  }, [thumbUrl]);

  if (thumbUrl && !broken) {
    return (
      <span className={styles.avatarPortraitWrap} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl}
          alt=""
          className={styles.avatarPortrait}
          onError={() => setBroken(true)}
        />
        {tint && (
          <span className={styles.avatarTintLayer} style={{ background: tint }} aria-hidden />
        )}
      </span>
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
