"use client";

import { useEffect, useState } from "react";
import { ARCHETYPES, thumbUrl, archetypeUrl, type Gender } from "@/lib/avatars";
import {
  AVATAR_TINTS,
  archetypeExists,
  defaultSelection,
  type AvatarSelection,
} from "@/lib/avatar-store";
import styles from "./avatar-picker.module.css";

export interface AvatarPickerProps {
  open: boolean;
  /** Selección de partida (o null → arranca en la de por defecto). */
  initial?: AvatarSelection | null;
  onClose(): void;
  /**
   * Confirma la selección. `available` = si el GLB del arquetipo ya existe
   * (HEAD). Si es false, el llamador muestra el aviso “aún duerme” y el mundo cae
   * con gracia al maniquí — pero la elección se guarda igual, lista para cuando
   * llegue el modelo.
   */
  onApply(sel: AvatarSelection, available: boolean): void;
}

/**
 * Selector de arquetipo: panel glass de marca con la cuadrícula de 9 arquetipos
 * (miniaturas de las láminas), selector M/F y 3 paletas de tinte. Funciona HOY
 * aunque no exista ningún GLB: al confirmar, si el modelo no está, el mundo usa
 * el maniquí con el tinte elegido.
 */
export function AvatarPicker({ open, initial, onClose, onApply }: AvatarPickerProps) {
  const [sel, setSel] = useState<AvatarSelection>(initial ?? defaultSelection());
  const [applying, setApplying] = useState(false);

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

  if (!open) return null;

  const setGender = (gender: Gender) => setSel((s) => ({ ...s, gender }));
  const setArchetype = (archetype: string) => setSel((s) => ({ ...s, archetype }));
  const setTint = (tint: AvatarSelection["tint"]) => setSel((s) => ({ ...s, tint }));

  const confirm = async () => {
    if (applying) return;
    setApplying(true);
    const available = await archetypeExists(archetypeUrl(sel.archetype, sel.gender));
    setApplying(false);
    onApply(sel, available);
  };

  const activeArchetype = ARCHETYPES.find((a) => a.id === sel.archetype);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Elige tu arquetipo">
      <section className={styles.panel}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        <header className={styles.head}>
          <span className={styles.eyebrow}>Tu avatar</span>
          <h2 className={styles.title}>Elige tu arquetipo</h2>
          <p className={styles.lead}>
            Nueve viajeros arquetípicos. Aún se están materializando: elige el tuyo
            y aparecerás con él en cuanto despierte.
          </p>
        </header>

        {/* Cuadrícula de arquetipos */}
        <div className={styles.grid} role="radiogroup" aria-label="Arquetipo">
          {ARCHETYPES.map((a) => {
            const active = a.id === sel.archetype;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={active}
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

        {/* Controles: género + tinte */}
        <div className={styles.controls}>
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>Género</span>
            <div className={styles.segment} role="group" aria-label="Género">
              <button
                type="button"
                className={`${styles.segBtn} ${sel.gender === "m" ? styles.segActive : ""}`}
                aria-pressed={sel.gender === "m"}
                onClick={() => setGender("m")}
              >
                Masculino
              </button>
              <button
                type="button"
                className={`${styles.segBtn} ${sel.gender === "f" ? styles.segActive : ""}`}
                aria-pressed={sel.gender === "f"}
                onClick={() => setGender("f")}
              >
                Femenino
              </button>
            </div>
          </div>

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
          </div>
        </div>

        <div className={styles.actions}>
          <span className={styles.selName}>{activeArchetype?.name}</span>
          <button type="button" className={styles.confirm} onClick={confirm} disabled={applying}>
            {applying ? "Preparando…" : "Encarnar"}
          </button>
        </div>
      </section>
    </div>
  );
}
