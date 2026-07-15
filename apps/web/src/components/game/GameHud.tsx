"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GameSnapshotUi, WorldUiHooks } from "@/lib/world-ui";
import styles from "./game.module.css";

export interface GameHudProps {
  /** Getter perezoso del MUNDO (para world.game.*). Degrada si aún no existe. */
  getWorld: () => WorldUiHooks | null;
}

const IDLE_SNAP: GameSnapshotUi = {
  phase: "idle",
  endsAt: 0,
  scores: {},
  startedBy: "",
  winnerIds: [],
  names: {},
  localId: "",
};

/**
 * Radio (u) del claro de Paqo alrededor del origen (0,0). La píldora "Comenzar
 * juego" (idle) sólo aparece si el avatar está DENTRO de este claro; una vez que
 * el juego corre, el marcador se muestra estés donde estés.
 */
const CLEARING_RADIUS = 9;
/** Cadencia del sondeo de posición para el gating (2 Hz: ligero y robusto). */
const POSITION_POLL_MS = 500;

/** Nombre visible de un id (con fallback "Tú" para el local, "Anónimo" si falta). */
function nameOf(snap: GameSnapshotUi, id: string): string {
  if (snap.names[id]) return snap.names[id];
  return id === snap.localId ? "Tú" : "Anónimo";
}

/**
 * GameHud — HUD del mini-juego ¡Dale a Paqo! (equipo Juego).
 *
 * IDLE: píldora discreta abajo-izquierda "Comenzar juego". RUNNING: tarjeta compacta
 * arriba-centro con cuenta atrás M:SS (derivada de endsAt) + marcador de jugadores
 * conectados (líder con corona, tú resaltado) + "Detener". RESULTS: banner breve del
 * ganador que se desvanece a idle solo. Se cablea a `world.game` con optional-chaining
 * sobre el getter perezoso; la difusión por red vive en la capa de realtime.
 */
export function GameHud({ getWorld }: GameHudProps) {
  const [snap, setSnap] = useState<GameSnapshotUi>(IDLE_SNAP);
  const [gameReady, setGameReady] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // ¿El avatar está dentro del claro de Paqo? Sólo se sondea en IDLE (barato).
  const [inClearing, setInClearing] = useState(false);

  // Engancha world.game.onChange en cuanto exista (reintento acotado, como
  // MobileControls: el engine monta world.game tras start()).
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | undefined;

    const wire = () => {
      if (cancelled) return;
      const game = getWorld?.()?.game;
      if (game?.onChange && game.snapshot) {
        setSnap(game.snapshot());
        off = game.onChange((s) => setSnap(s));
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

  // Ticker de la cuenta atrás sólo mientras corre (deriva de endsAt).
  useEffect(() => {
    if (snap.phase !== "running") return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [snap.phase]);

  // Gating por posición: SÓLO en idle sondeamos ligeramente (2 Hz) el controller
  // del mundo para saber si el avatar pisa el claro de Paqo. Fuera de idle no hace
  // falta (el marcador running/results se muestra siempre). Distancia XZ al origen.
  useEffect(() => {
    if (snap.phase !== "idle") return;
    let cancelled = false;
    const sample = () => {
      if (cancelled) return;
      const pos = getWorld?.()?.controller?.position;
      // Si el mundo aún no expone el controller, no cambiamos el estado (degrada).
      if (pos) setInClearing(Math.hypot(pos.x, pos.z) < CLEARING_RADIUS);
    };
    sample();
    const id = setInterval(sample, POSITION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [snap.phase, getWorld]);

  const onStart = useCallback(() => getWorld?.()?.game?.start?.(), [getWorld]);
  const onStop = useCallback(() => getWorld?.()?.game?.stop?.(), [getWorld]);

  // Jugadores = unión de (roster/nombres) ∪ (ids con puntos) ∪ (tú), ordenados por
  // puntos desc y luego por nombre.
  const players = useMemo(() => {
    const ids = new Set<string>();
    for (const id of Object.keys(snap.names)) ids.add(id);
    for (const id of Object.keys(snap.scores)) ids.add(id);
    if (snap.localId) ids.add(snap.localId);
    const rows = [...ids].map((id) => ({
      id,
      points: snap.scores[id] ?? 0,
      name: nameOf(snap, id),
      me: id === snap.localId,
    }));
    rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return rows;
  }, [snap]);

  const topScore = players.length > 0 ? players[0].points : 0;

  if (snap.phase === "idle") {
    // La píldora sólo se ofrece DENTRO del claro de Paqo. Se mantiene montada y se
    // muestra/oculta por clase para que la aparición/desaparición sea suave (fade +
    // leve slide) al entrar/salir del claro. Oculta = no enfocable ni clicable.
    const show = inClearing;
    return (
      <button
        type="button"
        className={`${styles.startPill} ${show ? styles.startPillVisible : styles.startPillHidden}`}
        onClick={onStart}
        disabled={!gameReady}
        aria-hidden={!show}
        tabIndex={show ? undefined : -1}
        aria-label="Comenzar juego: lánzale las pelotas a Paqo"
      >
        <span className={styles.startDot} aria-hidden>
          ◦
        </span>
        Comenzar juego
      </button>
    );
  }

  if (snap.phase === "results") {
    const winners = snap.winnerIds.map((id) => nameOf(snap, id));
    const label =
      winners.length === 0
        ? "Ronda sin aciertos"
        : winners.length === 1
          ? `Gana ${winners[0]}`
          : `Empate: ${winners.join(" · ")}`;
    return (
      <div className={styles.banner} role="status" aria-live="polite">
        <span className={styles.trophy} aria-hidden>
          🏆
        </span>
        {label}
      </div>
    );
  }

  // RUNNING
  const remaining = Math.max(0, snap.endsAt - nowMs);
  const mm = Math.floor(remaining / 60_000);
  const ss = Math.floor((remaining % 60_000) / 1000);
  const clock = `${mm}:${String(ss).padStart(2, "0")}`;

  return (
    <section className={styles.card} aria-label="Marcador ¡Dale a Paqo!">
      <div className={styles.clock}>{clock}</div>
      <ul className={styles.players} aria-live="polite" aria-label="Puntuaciones">
        {players.map((p) => {
          const lead = p.points > 0 && p.points === topScore;
          return (
            <li
              key={p.id}
              className={`${styles.row} ${p.me ? styles.meRow : ""} ${lead ? styles.leadRow : ""}`}
            >
              <span className={styles.pname}>
                {lead && (
                  <span className={styles.crown} aria-hidden>
                    ♛
                  </span>
                )}
                {p.name}
                {p.me && p.name !== "Tú" && <span className={styles.youTag}>&nbsp;(tú)</span>}
              </span>
              <span className={styles.ppts}>{p.points}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className={styles.stopBtn} onClick={onStop} aria-label="Detener juego">
        Detener
      </button>
    </section>
  );
}
