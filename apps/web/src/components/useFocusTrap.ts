"use client";

import { useEffect, type RefObject } from "react";

/** Selector de todo lo enfocable por teclado dentro de un contenedor. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focus-trap accesible para diálogos modales (WCAG 2.4.3 / 2.1.2):
 *   · al activarse, mueve el foco al primer control (o a `initialFocusRef`);
 *   · atrapa Tab / Shift+Tab dentro del contenedor (ciclo);
 *   · al desactivarse, restaura el foco al elemento que lo tenía antes (el
 *     disparador que abrió el modal).
 *
 * El cierre con Escape lo gestiona cada modal (ya lo hacían); este hook no lo
 * duplica para no pisar su lógica.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Foco inicial: control indicado, o el primero enfocable.
    const initial = initialFocusRef?.current ?? focusables()[0] ?? null;
    initial?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Restaura el foco al disparador si sigue en el documento.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}
