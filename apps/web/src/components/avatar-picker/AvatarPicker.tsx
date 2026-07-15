"use client";

import { useEffect, useRef, useState } from "react";
import { thumbUrl } from "@/lib/avatars";
import { PASTEL_COLORS } from "@/lib/names";
import { defaultSelection, type AvatarSelection } from "@/lib/avatar-store";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useModalLock } from "@/components/modal-lock";
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

  const thumb = thumbUrl();

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

        {/* Retrato de nube tintado en vivo: la miniatura (body blanco) con un
            overlay del color en multiply, enmascarado por la propia imagen. */}
        <div className={styles.nubeStage}>
          <div className={styles.nubeFigure}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumb} alt="" aria-hidden className={styles.nubeImg} />
            <span
              className={styles.nubeTint}
              aria-hidden
              style={{
                backgroundColor: color,
                WebkitMaskImage: `url(${thumb})`,
                maskImage: `url(${thumb})`,
              }}
            />
          </div>
        </div>

        {/* Paleta pastel-plastilina (chips) + picker libre */}
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Color</span>
          <div className={styles.chips} role="radiogroup" aria-label="Paleta de colores">
            {PASTEL_COLORS.map((c) => {
              const active = c.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={active}
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
