"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadAvatarRigShared,
  type IAvatarRig,
} from "@phygitalia/engine";
import { ARCHETYPES, genGlbUrl, type BuildId, BUILDS } from "@/lib/avatars";
import {
  AVATAR_TINTS,
  defaultSelection,
  type AvatarSelection,
  type AvatarTint,
} from "@/lib/avatar-store";
import { AvatarCarousel } from "@/app/avatar-carousel";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useModalLock } from "@/components/modal-lock";
import styles from "./avatar-picker.module.css";

/** Las 5 zonas de tinte del editor, en orden de aparición. */
const TINT_FIELDS: { key: keyof AvatarTint; label: string }[] = [
  { key: "primary", label: "Principal" },
  { key: "secondary", label: "Secundario" },
  { key: "hair", label: "Pelo" },
  { key: "skin", label: "Piel" },
  { key: "accent", label: "Acento" },
];

const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id);

export interface AvatarPickerProps {
  open: boolean;
  /** Selección de partida (o null → arranca en la de por defecto). */
  initial?: AvatarSelection | null;
  onClose(): void;
  /** Confirma la selección: el mundo encarna el avatar modelado al instante. */
  onApply(sel: AvatarSelection): void;
}

/**
 * Selector de avatar REDISEÑADO: una ruleta 3D ceremonial de los 9 arquetipos
 * (chibi procedural instantáneo que sube al GLB MODELADO del build elegido), con
 * chips de build F/M/N y un editor de color de 5 zonas con vista previa en vivo.
 * Bottom-sheet a pantalla completa en móvil, tarjeta centrada en desktop. Glass de
 * la casa (@phygitalia/ui), Chakra Petch, dorado #e3b063.
 */
export function AvatarPicker({ open, initial, onClose, onApply }: AvatarPickerProps) {
  const [sel, setSel] = useState<AvatarSelection>(initial ?? defaultSelection());
  const panelRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<AvatarCarousel | null>(null);

  // Refs vivas para que la factoría de rigs del carrusel lea build/tint frescos.
  const buildRef = useRef<BuildId>(sel.build);
  const tintRef = useRef<AvatarTint>(sel.tint);
  buildRef.current = sel.build;
  tintRef.current = sel.tint;

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

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

  useFocusTrap(open, panelRef);
  useModalLock(open);

  // ── Ruleta 3D: monta al abrir, libera al cerrar ──────────────────────────
  useEffect(() => {
    if (!open || !stageRef.current) return;
    const initialIndex = Math.max(0, ARCHETYPE_IDS.indexOf((initial ?? sel).archetype));

    const carousel = new AvatarCarousel(stageRef.current, ARCHETYPE_IDS, {
      reducedMotion,
      initialIndex,
      onSelect: (index) => {
        const id = ARCHETYPE_IDS[index];
        setSel((s) => (s.archetype === id ? s : { ...s, archetype: id }));
      },
      // Sube cada chibi al GLB modelado del build vigente (fallback: procedural).
      loadRig: (archetypeId): Promise<IAvatarRig | null> =>
        loadAvatarRigShared(genGlbUrl(archetypeId, buildRef.current)).catch(() => null),
    });
    carousel.start();
    carousel.setTint(tintRef.current);
    carouselRef.current = carousel;

    return () => {
      carousel.dispose();
      carouselRef.current = null;
    };
    // Sólo (re)monta al abrir; los cambios de build/tint van por sus efectos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reducedMotion]);

  // Trae el arquetipo elegido al frente de la ruleta (chips/flechas → carrusel).
  useEffect(() => {
    if (!open) return;
    const i = ARCHETYPE_IDS.indexOf(sel.archetype);
    if (i >= 0) carouselRef.current?.goTo(i);
  }, [open, sel.archetype]);

  // Recarga los GLB del anillo al cambiar de build.
  useEffect(() => {
    if (!open) return;
    carouselRef.current?.reload();
  }, [open, sel.build]);

  // Aplica el tinte en vivo al cambiar cualquier picker.
  useEffect(() => {
    if (!open) return;
    carouselRef.current?.setTint(sel.tint);
  }, [open, sel.tint]);

  if (!open) return null;

  const setArchetypeByIndex = (index: number) => {
    const i = ((index % ARCHETYPE_IDS.length) + ARCHETYPE_IDS.length) % ARCHETYPE_IDS.length;
    setSel((s) => ({ ...s, archetype: ARCHETYPE_IDS[i] }));
  };
  const setBuild = (build: BuildId) => setSel((s) => ({ ...s, build }));
  const setZone = (zone: keyof AvatarTint, hex: string) =>
    setSel((s) => ({ ...s, tint: { ...s.tint, [zone]: hex } }));
  const applyPreset = (tint: AvatarTint) => setSel((s) => ({ ...s, tint: { ...tint } }));

  const activeIndex = ARCHETYPE_IDS.indexOf(sel.archetype);
  const activeArchetype = ARCHETYPES.find((a) => a.id === sel.archetype);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Elige tu avatar">
      <section className={styles.panel} ref={panelRef}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        <header className={styles.head}>
          <span className={styles.eyebrow}>Tu avatar</span>
          <h2 className={styles.title}>Elige tu arquetipo</h2>
        </header>

        {/* Ruleta 3D + flechas + nombre */}
        <div className={styles.stageWrap}>
          <div className={styles.stage} ref={stageRef} aria-hidden />
          <button
            type="button"
            className={`${styles.arrow} ${styles.arrowPrev}`}
            onClick={() => setArchetypeByIndex(activeIndex - 1)}
            aria-label="Arquetipo anterior"
          >
            ‹
          </button>
          <button
            type="button"
            className={`${styles.arrow} ${styles.arrowNext}`}
            onClick={() => setArchetypeByIndex(activeIndex + 1)}
            aria-label="Arquetipo siguiente"
          >
            ›
          </button>
          <span className={styles.stageName} role="status" aria-live="polite">
            {activeArchetype?.name}
          </span>
        </div>

        {/* Build F/M/N */}
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Cuerpo</span>
          <div className={styles.segment} role="radiogroup" aria-label="Build de cuerpo">
            {BUILDS.map((b) => {
              const active = b.id === sel.build;
              return (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.segBtn} ${active ? styles.segActive : ""}`}
                  onClick={() => setBuild(b.id)}
                  title={b.name}
                >
                  <span className={styles.segShort}>{b.short}</span>
                  <span className={styles.segName}>{b.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Editor de color — 5 zonas con vista previa en vivo */}
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>Color por zona</span>
          <div className={styles.pickers}>
            {TINT_FIELDS.map((f) => (
              <label key={f.key} className={styles.picker}>
                <input
                  type="color"
                  className={styles.pickerInput}
                  value={sel.tint[f.key]}
                  onChange={(e) => setZone(f.key, e.target.value)}
                  aria-label={`Color ${f.label}`}
                />
                <span className={styles.pickerLabel}>{f.label}</span>
              </label>
            ))}
          </div>
          <div className={styles.presets} role="group" aria-label="Paletas rápidas">
            {AVATAR_TINTS.map((p) => (
              <button
                key={p.name}
                type="button"
                className={styles.preset}
                title={p.name}
                aria-label={`Paleta ${p.name}`}
                onClick={() => applyPreset(p.tint)}
                style={{
                  background: `linear-gradient(135deg, ${p.tint.primary} 0 40%, ${p.tint.accent} 40% 70%, ${p.tint.hair} 70% 100%)`,
                }}
              />
            ))}
          </div>
        </div>

        <div className={styles.actions}>
          <span className={styles.selName}>
            {activeArchetype?.name} · {BUILDS.find((b) => b.id === sel.build)?.name}
          </span>
          <button type="button" className={styles.confirm} onClick={() => onApply(sel)}>
            Encarnar
          </button>
        </div>
      </section>
    </div>
  );
}
