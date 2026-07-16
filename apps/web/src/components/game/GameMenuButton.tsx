"use client";

import { useCallback, useEffect, useState } from "react";
import type { GameSnapshotUi, WorldUiHooks } from "@/lib/world-ui";
import styles from "./game-menu-button.module.css";

export interface GameMenuButtonProps {
  /** Getter perezoso del MUNDO (para world.game.* y controller.position). Degrada si aún no existe. */
  getWorld: () => WorldUiHooks | null;
}

/**
 * Radio (u) del claro de Paqo alrededor del origen (0,0). En IDLE el botón sólo se
 * habilita si el avatar está DENTRO de este claro; fuera, queda deshabilitado con
 * el aviso "Acércate al claro de Paqo". (Mismo umbral que usaba la píldora del
 * antiguo GameHud, que este botón de menú reemplaza.)
 */
const CLEARING_RADIUS = 9;
/** Cadencia del sondeo de posición para el gating (2 Hz: ligero y robusto). */
const POSITION_POLL_MS = 500;

/**
 * GameMenuButton — botón "Comenzar juego" del MENÚ superior (equipo Juego).
 *
 * Reemplaza la antigua píldora flotante de GameHud. Icono ▶ (reproducir) en IDLE:
 * habilitado SÓLO dentro del claro de Paqo (r<9, sondeo 2 Hz); fuera, deshabilitado
 * con title "Acércate al claro de Paqo". Al pulsarlo → world.game.start(). Cuando el
 * juego CORRE cambia a icono ⏹ con title "Detener" y llama world.game.stop(). El
 * marcador y el banner de resultados los sigue pintando GameHud (arriba-centro).
 */
export function GameMenuButton({ getWorld }: GameMenuButtonProps) {
  const [phase, setPhase] = useState<GameSnapshotUi["phase"]>("idle");
  const [gameReady, setGameReady] = useState(false);
  // ¿El avatar está dentro del claro de Paqo? Sólo se sondea en IDLE (barato).
  const [inClearing, setInClearing] = useState(false);

  // Engancha world.game.onChange en cuanto exista (reintento acotado, igual que el
  // antiguo GameHud: el engine monta world.game tras start()).
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | undefined;

    const wire = () => {
      if (cancelled) return;
      const game = getWorld?.()?.game;
      if (game?.onChange && game.snapshot) {
        setPhase(game.snapshot().phase);
        off = game.onChange((s) => setPhase(s.phase));
        setGameReady(true);
        return;
      }
      if (tries++ < 40) timer = setTimeout(wire, 400);
    };
    wire();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, [getWorld]);

  // Gating por posición: SÓLO en idle sondeamos ligeramente (2 Hz) el controller del
  // mundo para saber si el avatar pisa el claro de Paqo. Fuera de idle no hace falta
  // (corriendo el botón es "Detener"; en resultados queda inerte). Distancia XZ al origen.
  useEffect(() => {
    if (phase !== "idle") return;
    let cancelled = false;
    const sample = () => {
      if (cancelled) return;
      const pos = getWorld?.()?.controller?.position;
      if (pos) setInClearing(Math.hypot(pos.x, pos.z) < CLEARING_RADIUS);
    };
    sample();
    const id = setInterval(sample, POSITION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, getWorld]);

  const onStart = useCallback(() => getWorld?.()?.game?.start?.(), [getWorld]);
  const onStop = useCallback(() => getWorld?.()?.game?.stop?.(), [getWorld]);

  const running = phase === "running";
  // IDLE → habilitado sólo dentro del claro; RUNNING → habilitado (Detener);
  // RESULTS → inerte mientras se desvanece a idle.
  const disabled = running ? !gameReady : phase === "results" ? true : !(gameReady && inClearing);
  const label = running ? "Detener juego" : "Comenzar juego: lánzale las pelotas a Paqo";
  const title = running ? "Detener" : inClearing ? "Comenzar juego" : "Acércate al claro de Paqo";

  return (
    <button
      type="button"
      className={`${styles.button} ${styles.tip}`}
      onClick={running ? onStop : onStart}
      disabled={disabled}
      aria-pressed={running}
      aria-label={label}
      title={title}
      data-tip={title}
    >
      {running ? <StopGlyph /> : <PlayGlyph />}
    </button>
  );
}

/** Glifo ▶ de reproducir (triángulo, mismo lenguaje de trazo/relleno del set del HUD). */
function PlayGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 5.5v13l11-6.5-11-6.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.14"
      />
    </svg>
  );
}

/** Glifo ⏹ de detener (cuadrado redondeado). */
function StopGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="6.5"
        y="6.5"
        width="11"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="currentColor"
        fillOpacity="0.14"
      />
    </svg>
  );
}
