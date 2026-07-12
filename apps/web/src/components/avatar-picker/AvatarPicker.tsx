"use client";

import { useEffect, useRef, useState } from "react";
import { ARCHETYPES, thumbUrl } from "@/lib/avatars";
import {
  AVATAR_TINTS,
  defaultSelection,
  type AvatarSelection,
} from "@/lib/avatar-store";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useModalLock } from "@/components/modal-lock";
import styles from "./avatar-picker.module.css";

/** Columnas lógicas de la cuadrícula (para navegación con flechas ↑↓). */
const GRID_COLS = 3;

export interface AvatarPickerProps {
  open: boolean;
  /** Selección de partida (o null → arranca en la de por defecto). */
  initial?: AvatarSelection | null;
  onClose(): void;
  /**
   * Confirma la selección. Los 9 arquetipos son procedurales (siempre
   * disponibles): al aplicar, el mundo encarna el chibi al instante.
   */
  onApply(sel: AvatarSelection): void;
}

/**
 * Selector de arquetipo: panel glass de marca con la cuadrícula de 9 arquetipos
 * PROCEDURALES (miniaturas de las láminas) y 3 paletas de tinte. Sin género: son
 * 9 avatares distintos, todos disponibles — al confirmar, el mundo los construye
 * en código (buildArchetype) sin esperar ninguna descarga.
 */
export function AvatarPicker({ open, initial, onClose, onApply }: AvatarPickerProps) {
  const [sel, setSel] = useState<AvatarSelection>(initial ?? defaultSelection());
  const panelRef = useRef<HTMLElement>(null);
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Re-sincroniza con `initial` cada vez que se abre (p.ej. desde el HUD).
  useEffect(() => {
    if (open) setSel(initial ?? defaultSelection());
  }, [open, initial]);

  // Cierra con Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Foco atrapado dentro del diálogo + restaura foco al disparador al cerrar.
  useFocusTrap(open, panelRef);
  // Oculta el banner de cookies mientras el selector esté abierto.
  useModalLock(open);

  if (!open) return null;

  const setArchetype = (archetype: string) => setSel((s) => ({ ...s, archetype }));
  const setTint = (tint: AvatarSelection["tint"]) => setSel((s) => ({ ...s, tint }));

  // Roving tabindex: la cuadrícula es un único tab-stop; las flechas mueven la
  // selección y el foco entre arquetipos (patrón radiogroup, WCAG 4.1.2).
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const ids = ARCHETYPES.map((a) => a.id);
    const idx = ids.indexOf(sel.archetype);
    if (idx < 0) return;
    let next = idx;
    switch (e.key) {
      case "ArrowRight":
        next = (idx + 1) % ids.length;
        break;
      case "ArrowLeft":
        next = (idx - 1 + ids.length) % ids.length;
        break;
      case "ArrowDown":
        next = Math.min(idx + GRID_COLS, ids.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(idx - GRID_COLS, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ids.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    setArchetype(ids[next]);
    radioRefs.current[next]?.focus();
  };

  const confirm = () => onApply(sel);

  const activeArchetype = ARCHETYPES.find((a) => a.id === sel.archetype);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Elige tu arquetipo">
      <section className={styles.panel} ref={panelRef}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        <header className={styles.head}>
          <span className={styles.eyebrow}>Tu avatar</span>
          <h2 className={styles.title}>Elige tu arquetipo</h2>
          <p className={styles.lead}>
            Nueve viajeros arquetípicos. Elige el tuyo y encarnarás con él al
            instante.
          </p>
        </header>

        {/* Cuadrícula de arquetipos (roving tabindex + flechas) */}
        <div className={styles.grid} role="radiogroup" aria-label="Arquetipo" onKeyDown={onGridKey}>
          {ARCHETYPES.map((a, i) => {
            const active = a.id === sel.archetype;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                ref={(el) => {
                  radioRefs.current[i] = el;
                }}
                className={`${styles.card} ${active ? styles.cardActive : ""}`}
                onClick={() => setArchetype(a.id)}
                title={a.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.thumb}
                  src={thumbUrl(a.id)}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
                <span className={styles.cardName}>{a.name}</span>
              </button>
            );
          })}
        </div>

        {/* Controles: tinte */}
        <div className={styles.controls}>
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>Tinte</span>
            <div className={styles.swatches} role="group" aria-label="Paleta de tinte">
              {AVATAR_TINTS.map((p) => {
                const active = p.tint.primary === sel.tint.primary;
                return (
                  <button
                    key={p.name}
                    type="button"
                    className={`${styles.swatch} ${active ? styles.swatchActive : ""}`}
                    title={p.name}
                    aria-label={`Paleta ${p.name}`}
                    aria-pressed={active}
                    onClick={() => setTint({ ...p.tint })}
                    style={{
                      background: `linear-gradient(135deg, ${p.tint.primary} 0 55%, ${p.tint.secondary} 55% 80%, ${p.tint.hair} 80% 100%)`,
                    }}
                  />
                );
              })}
            </div>
            {/* Mini-label: aclara qué cambia cada tinte del avatar. */}
            <span className={styles.swatchHint}>Cambia tu color: principal · secundario · cabello</span>
          </div>
        </div>

        <div className={styles.actions}>
          <span className={styles.selName}>{activeArchetype?.name}</span>
          <button type="button" className={styles.confirm} onClick={confirm}>
            Encarnar
          </button>
        </div>
      </section>
    </div>
  );
}
