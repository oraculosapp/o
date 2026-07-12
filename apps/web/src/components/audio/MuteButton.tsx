"use client";

import { useEffect, useState } from "react";
import { getAudioMuted, setAudioMuted, subscribeAudioMuted } from "@phygitalia/engine";
import styles from "./mute-button.module.css";

/**
 * Botón de silencio del soundscape (design system Phygitalia). Side-button glass
 * con glifo de nota musical; al silenciar, la nota se tacha. El estado se PERSISTE
 * en localStorage y se COMPARTE con el motor de audio vía `muteStore` (el engine
 * escucha el cambio y hace rampa del gain maestro) — el botón no necesita una
 * referencia al mundo.
 *
 * Accesible: `aria-pressed` refleja el estado silenciado; label dinámico.
 * Se ancla arriba-derecha, a la izquierda del clúster de HudControls.
 */
export function MuteButton() {
  // Init false en SSR/primer render (evita mismatch de hidratación); el valor
  // real de localStorage se lee en el efecto.
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(getAudioMuted());
    return subscribeAudioMuted(setMuted);
  }, []);

  const toggle = (): void => setAudioMuted(!muted);

  return (
    <button
      type="button"
      className={styles.button}
      onClick={toggle}
      aria-pressed={muted}
      aria-label={muted ? "Activar sonido" : "Silenciar sonido"}
      title={muted ? "Activar sonido" : "Silenciar sonido"}
    >
      <NoteGlyph muted={muted} />
    </button>
  );
}

/** Glifo de nota musical (trazo 1.6px currentColor); tachado cuando está muted. */
function NoteGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 17.5V7l9-2v8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.5" cy="17.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15.5" cy="15.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
      {muted && (
        <path
          d="M4 4l16 16"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
