"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import styles from "./emote-menu.module.css";

/**
 * Emotes disponibles (deben coincidir con EMOTE_IDS del engine — EmoteDriver).
 * Se lista aquí con etiqueta/emoji para pintar el menú sin importar three.js.
 */
const EMOTES: { id: string; label: string; icon: string }[] = [
  { id: "dance1", label: "Baile", icon: "💃" },
  { id: "dance2", label: "Fiesta", icon: "🕺" },
  { id: "wave", label: "Saludo", icon: "👋" },
  { id: "spin", label: "Giro", icon: "🌀" },
  { id: "jump-cheer", label: "¡Hurra!", icon: "🎉" },
];

export interface EmoteMenuProps {
  open: boolean;
  onClose(): void;
  /**
   * Abre el menú (para el atajo global de teclado "B" — bailar). Opcional para no
   * romper llamadas existentes; si falta, "B" sólo puede cerrar.
   */
  onOpen?(): void;
  /** Dispara el emote elegido (playEmote local + difusión por la red). */
  onPick(id: string): void;
}

/** ¿El foco está en un campo de texto? (para no secuestrar "B" al escribir en el chat). */
function isTypingTarget(node: Element | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

/**
 * EmoteMenu — mini-panel de emotes (glass de la casa). Se abre al clicar/tocar TU
 * PROPIO avatar en el mundo (PaqoWorld.onAvatarClick) o con la tecla global "B"
 * (bailar), y se cierra al elegir un emote, con "B" de nuevo, con Escape, o
 * clicando fuera.
 *
 * Accesible (WCAG 2.1.1 / 2.4.3): al abrir, el foco va al primer menuitem; las
 * flechas ↑↓ (y ←→) navegan con roving tabindex; Escape cierra y RESTAURA el foco
 * al elemento previo (vía useFocusTrap, el mismo patrón que AvatarPicker).
 */
export function EmoteMenu({ open, onClose, onOpen, onPick }: EmoteMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(0);

  // Atajo GLOBAL "B" (bailar): abre/cierra el menú. No secuestra la tecla mientras
  // se escribe (chat) ni con modificadores. Vive fuera del guard de `open` para
  // poder ABRIR también (por eso el listener se monta siempre).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "b" && e.key !== "B") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      if (open) onClose();
      else onOpen?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onOpen]);

  // Al abrir, el ítem activo (roving tabindex) vuelve al primero.
  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  // Escape cierra (la restauración del foco la hace useFocusTrap al desmontar).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Foco inicial al primer menuitem + restauración del foco al cerrar (mismo hook
  // que AvatarPicker). La navegación por flechas la lleva el propio menú (abajo).
  useFocusTrap(open, panelRef);

  if (!open) return null;

  // Mueve el foco (y el roving tabindex) al ítem i, con wrap-around.
  const focusItem = (i: number) => {
    const n = EMOTES.length;
    const next = ((i % n) + n) % n;
    setActive(next);
    itemRefs.current[next]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        focusItem(active + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        focusItem(active - 1);
        break;
      case "Home":
        e.preventDefault();
        focusItem(0);
        break;
      case "End":
        e.preventDefault();
        focusItem(EMOTES.length - 1);
        break;
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className={styles.panel}
        role="menu"
        aria-label={'Emotes de tu avatar — abre y cierra con la tecla «B» (bailar); ↑↓ para elegir, Esc para cerrar'}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        {EMOTES.map((emote, i) => (
          <button
            key={emote.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={i === active ? 0 : -1}
            className={styles.emote}
            onClick={() => {
              onPick(emote.id);
              onClose();
            }}
          >
            <span className={styles.icon} aria-hidden>
              {emote.icon}
            </span>
            <span className={styles.label}>{emote.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
