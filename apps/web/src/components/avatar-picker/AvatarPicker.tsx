"use client";

import { useEffect, useRef, useState } from "react";
import { PASTEL_COLORS } from "@/lib/names";
import { defaultSelection, type AvatarSelection } from "@/lib/avatar-store";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useModalLock } from "@/components/modal-lock";
import { AvatarLivePreview } from "./AvatarLivePreview";
import styles from "./avatar-picker.module.css";

export interface AvatarPickerProps {
  open: boolean;
  /** Selección de partida (o null → arranca con un color aleatorio). */
  initial?: AvatarSelection | null;
  onClose(): void;
  /** Confirma la selección: el mundo tinta el avatar nube al instante. */
  onApply(sel: AvatarSelection): void;
}

/**
 * Selector de avatar SIMPLIFICADO (S8, dirección "nube"): un único diseño neutro
 * de plastilina para todos — la personalización es SÓLO el color. Muestra el
 * retrato de nube tintado EN VIVO (overlay multiplicativo enmascarado por la
 * propia miniatura), una paleta de chips pastel-plastilina (~16) y un picker
 * libre. Glass de la casa, Chakra Petch, dorado #e3b063.
 *
 * Adiós arquetipos/builds/5 zonas: el body es 1 zona (+ ojos fijos negros).
 */
export function AvatarPicker({ open, initial, onClose, onApply }: AvatarPickerProps) {
  const [color, setColor] = useState<string>((initial ?? defaultSelection()).color);
  const panelRef = useRef<HTMLElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Re-sincroniza con `initial` cada vez que se abre (p.ej. desde el HUD).
  useEffect(() => {
    if (open) setColor((initial ?? defaultSelection()).color);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cierra con Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useFocusTrap(open, panelRef);
  useModalLock(open);

  if (!open) return null;

  // Índice del chip seleccionado (−1 si el color viene del picker libre y no coincide
  // con ninguno de la paleta). Es el ancla del roving tabindex de abajo.
  const activeChip = PASTEL_COLORS.findIndex((c) => c.toLowerCase() === color.toLowerCase());

  /**
   * A11Y (WAI-ARIA, patrón Radio Group): un `role="radiogroup"` se recorre con las
   * FLECHAS, no con Tab —los 16 chips eran todos tabulables y las flechas no hacían
   * nada, que es justo lo contrario de lo que anuncia el rol—. Ahora:
   *   · roving tabindex: sólo el chip seleccionado entra en el orden de tabulación,
   *     así que Tab cruza la paleta de una vez (antes costaba 16 pulsaciones llegar
   *     al "Color libre"); si el color es del picker libre, el ancla es el primero.
   *   · ←↑ / →↓ mueven el foco Y seleccionan (con vuelta al principio), Home/End a
   *     los extremos. Mismo patrón de teclado que ya usan EmoteMenu y los tabs del
   *     chat, para que todo el mundo se navegue igual.
   */
  const focusChip = (i: number) => {
    const n = PASTEL_COLORS.length;
    const next = ((i % n) + n) % n;
    setColor(PASTEL_COLORS[next]);
    chipRefs.current[next]?.focus();
  };

  const onChipsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const from = activeChip < 0 ? 0 : activeChip;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusChip(from + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusChip(from - 1);
        break;
      case "Home":
        e.preventDefault();
        focusChip(0);
        break;
      case "End":
        e.preventDefault();
        focusChip(PASTEL_COLORS.length - 1);
        break;
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Elige tu color">
      <section className={styles.panel} ref={panelRef}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        <header className={styles.head}>
          <span className={styles.eyebrow}>Tu avatar</span>
          <h2 className={styles.title}>Elige tu color</h2>
        </header>

        {/* Mini-visor 3D EN VIVO del avatar nube: camina en el sitio, parpadea y
            cambia de color al instante. Cae al retrato estático si WebGL falla. */}
        <AvatarLivePreview color={color} />

        {/* Paleta pastel-plastilina (chips) + picker libre */}
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Color</span>
          <div
            className={styles.chips}
            role="radiogroup"
            aria-label="Paleta de colores"
            onKeyDown={onChipsKeyDown}
          >
            {PASTEL_COLORS.map((c, i) => {
              const active = i === activeChip;
              return (
                <button
                  key={c}
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  // Roving tabindex: sólo el seleccionado es tabulable (si el color
                  // salió del picker libre no hay ninguno activo → ancla el primero).
                  tabIndex={active || (activeChip < 0 && i === 0) ? 0 : -1}
                  aria-label={`Color ${c}`}
                  className={`${styles.chip} ${active ? styles.chipActive : ""}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              );
            })}
          </div>
          <label className={styles.freePick}>
            <input
              type="color"
              className={styles.pickerInput}
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Color libre"
            />
            <span className={styles.pickerLabel}>Color libre</span>
          </label>
        </div>

        <div className={styles.actions}>
          <span className={styles.selName}>Nube · {color}</span>
          <button type="button" className={styles.confirm} onClick={() => onApply({ color })}>
            Encarnar
          </button>
        </div>
      </section>
    </div>
  );
}
