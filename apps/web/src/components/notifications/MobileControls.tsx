"use client";

import { useEffect, useRef, useState } from "react";
import type { GetWorld, WorldActionState } from "@/lib/world-ui";
import styles from "./mobile-controls.module.css";

export interface MobileControlsProps {
  /** Getter perezoso del MUNDO (para world.input.*). Degrada si aún no existe. */
  getWorld?: GetWorld;
}

const DEFAULT_STATE: WorldActionState = {
  canGrab: false,
  holding: false,
  grounded: true,
  canDoubleJump: false,
};

/** ¿El dispositivo es táctil? (por capacidad del puntero, nunca por user-agent). */
function useIsTouch(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(pointer: coarse)");
    const apply = () => setTouch(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return touch;
}

/**
 * Botones táctiles de ACCIÓN en la parte inferior-derecha (sólo en dispositivos
 * touch; el joystick vive a la izquierda, lo dibuja el engine). Consumen la
 * sub-API `world.input` con optional-chaining (degradación elegante si el engine
 * aún no la expone):
 *   · SALTAR  → world.input.pressJump()  (doble salto = pulsar dos veces).
 *   · AGARRAR/LANZAR → world.input.pressGrab(); sólo visible cuando
 *     `canGrab || holding`, y su etiqueta alterna según `holding`.
 *
 * Se suscribe a `world.input.onActionState(cb)` para reflejar el estado; reintenta
 * enganchar el mundo hasta ~12 s por si el engine monta `input` tras el start().
 */
export function MobileControls({ getWorld }: MobileControlsProps) {
  const isTouch = useIsTouch();
  const [state, setState] = useState<WorldActionState>(DEFAULT_STATE);
  const offRef = useRef<(() => void) | null>(null);

  // Engancha onActionState en cuanto world.input exista (reintento acotado).
  useEffect(() => {
    if (!isTouch) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const wire = () => {
      if (cancelled) return;
      const input = getWorld?.()?.input;
      if (input?.onActionState) {
        offRef.current = input.onActionState((s) => setState(s));
        return;
      }
      if (tries++ < 20) timer = setTimeout(wire, 600);
    };
    wire();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      offRef.current?.();
      offRef.current = null;
    };
  }, [isTouch, getWorld]);

  if (!isTouch) return null;

  const pressJump = () => getWorld?.()?.input?.pressJump?.();
  const pressGrab = () => getWorld?.()?.input?.pressGrab?.();

  const showGrab = state.canGrab || state.holding;
  const grabLabel = state.holding ? "Lanzar" : "Agarrar";

  return (
    <div className={styles.pad} aria-label="Controles de acción">
      {showGrab && (
        <button
          type="button"
          className={`${styles.btn} ${styles.grab} ${state.holding ? styles.holding : ""}`}
          onPointerDown={(e) => {
            e.preventDefault();
            pressGrab();
          }}
          aria-label={grabLabel}
        >
          {grabLabel}
        </button>
      )}
      <button
        type="button"
        className={`${styles.btn} ${styles.jump}`}
        onPointerDown={(e) => {
          e.preventDefault();
          pressJump();
        }}
        aria-label="Saltar"
      >
        Saltar
      </button>
    </div>
  );
}
