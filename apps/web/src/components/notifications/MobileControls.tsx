"use client";

import { useEffect, useRef, useState } from "react";
import type { GetWorld, WorldActionState } from "@/lib/world-ui";
import styles from "./mobile-controls.module.css";

export interface MobileControlsProps {
  /** Getter perezoso del MUNDO (para world.input.* / world.setDrawing). Degrada si aún no existe. */
  getWorld?: GetWorld;
}

const DEFAULT_STATE: WorldActionState = {
  canGrab: false,
  holding: false,
  grounded: true,
  canDoubleJump: false,
  flying: false,
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
 * Botones táctiles de MANDO en la parte inferior-derecha (sólo en dispositivos
 * touch; el joystick vive a la izquierda, lo dibuja el engine). Consumen la
 * sub-API `world.input` / `world.setDrawing` con optional-chaining (degradación
 * elegante si el engine aún no los expone):
 *   · ACCIÓN (siempre visible) → contextual:
 *       - cerca de pelota agarrable → "Tomar"; con pelota en mano → "Lanzar"
 *         (world.input.pressGrab());
 *       - lejos de pelotas → "Dibujar" (toggle: encendido = dorado; vuelve a picar
 *         para apagar) → world.setDrawing.
 *   · VOLAR (toggle) → world.input.pressFly(); alterna el modo vuelo (entrada
 *     alternativa al triple salto). Encendido (dorado) mientras vuela; tocarlo de
 *     nuevo = bajar. Va ARRIBA de Correr, en su misma columna.
 *   · CORRER (toggle, como Dibujar) → world.input.pressRun(); un toque enciende y se
 *     queda (dorado); otro toque apaga.
 *   · SALTAR → world.input.pressJump(); el triple toque encadena al VUELO y, en
 *     vuelo, la etiqueta pasa a "Caer" (misma acción: pulsar salto cae).
 *
 * Se suscribe a `world.input.onActionState(cb)` para reflejar el estado; reintenta
 * enganchar el mundo hasta ~12 s por si el engine monta `input` tras el start().
 */
export function MobileControls({ getWorld }: MobileControlsProps) {
  const isTouch = useIsTouch();
  const [state, setState] = useState<WorldActionState>(DEFAULT_STATE);
  const [drawing, setDrawing] = useState(false);
  const [running, setRunning] = useState(false);
  const offRef = useRef<(() => void) | null>(null);

  // Engancha onActionState en cuanto world.input exista (reintento acotado).
  useEffect(() => {
    if (!isTouch) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const wire = () => {
      if (cancelled) return;
      const world = getWorld?.();
      const input = world?.input;
      if (input?.onActionState) {
        offRef.current = input.onActionState((s) => setState(s));
        // Refleja el estado inicial del modo dibujar (si el mundo ya lo expone).
        setDrawing(Boolean(world?.isDrawing?.()));
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
  const pressFly = () => getWorld?.()?.input?.pressFly?.();
  // Correr en TOGGLE (como Dibujar): un toque enciende y se queda; otro toque apaga.
  // El estado "corriendo" se refleja localmente (dorado + aria-pressed).
  const toggleRun = () => {
    getWorld?.()?.input?.pressRun?.();
    setRunning((r) => !r);
  };

  const onAction = () => {
    const world = getWorld?.();
    if (state.canGrab || state.holding) {
      world?.input?.pressGrab?.();
      return;
    }
    // Lejos de pelotas: alterna el modo DIBUJAR.
    const next = !drawing;
    world?.setDrawing?.(next);
    setDrawing(next);
  };

  // Etiqueta contextual del botón de acción (en infinitivo, como el resto del mando:
  // Volar · Correr · Saltar · Tomar · Lanzar · Dibujar).
  const actionLabel = state.holding ? "Lanzar" : state.canGrab ? "Tomar" : "Dibujar";
  const drawingOn = actionLabel === "Dibujar" && drawing;
  const jumpLabel = state.flying ? "Caer" : "Saltar";

  return (
    <div className={styles.pad} role="group" aria-label="Controles de mando">
      <button
        type="button"
        className={`${styles.btn} ${styles.action} ${state.holding ? styles.holding : ""} ${
          drawingOn ? styles.drawingOn : ""
        }`}
        onPointerDown={(e) => {
          e.preventDefault();
          onAction();
        }}
        aria-label={actionLabel}
        aria-pressed={drawingOn || undefined}
      >
        {actionLabel}
      </button>

      <div className={styles.row}>
        {/* Columna izquierda: Volar ARRIBA, Correr ABAJO. */}
        <div className={styles.col}>
          <button
            type="button"
            className={`${styles.btn} ${styles.fly} ${state.flying ? styles.flyOn : ""}`}
            onPointerDown={(e) => {
              e.preventDefault();
              pressFly();
            }}
            aria-label="Volar"
            aria-pressed={state.flying}
          >
            Volar
          </button>

          <button
            type="button"
            className={`${styles.btn} ${styles.run} ${running ? styles.runOn : ""}`}
            onPointerDown={(e) => {
              e.preventDefault();
              toggleRun();
            }}
            aria-label="Correr"
            aria-pressed={running}
          >
            Correr
          </button>
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.jump} ${state.flying ? styles.flying : ""}`}
          onPointerDown={(e) => {
            e.preventDefault();
            pressJump();
          }}
          aria-label={jumpLabel}
        >
          {jumpLabel}
        </button>
      </div>
    </div>
  );
}
