"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export interface PerfOverlayProps {
  /**
   * Ref opcional al <canvas> del engine three.js cuyo tamaño se reporta.
   * Si no se pasa, se usa el primer <canvas> encontrado en el documento
   * (suficiente hoy: una sola escena three.js montada por página).
   */
  canvasRef?: RefObject<HTMLCanvasElement | null>;
}

interface PerfStats {
  fps: number;
  frameMs: number;
  memoryMb: number | null;
  canvasSize: string;
  dpr: number;
}

const INITIAL_STATS: PerfStats = {
  fps: 0,
  frameMs: 0,
  memoryMb: null,
  canvasSize: "–",
  dpr: 1,
};

/** performance.memory es no-estándar (sólo Chromium); se accede con cast local. */
interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number };
}

function isDevEnabled(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("dev") === "1";
}

/**
 * Overlay de rendimiento dev-only: FPS (media móvil de 1s), ms/frame,
 * memoria JS (si el navegador la expone), tamaño de canvas y devicePixelRatio.
 *
 * Se activa sólo en NODE_ENV=development o con `?dev=1` en la URL; en
 * cualquier otro caso no renderiza nada (ni siquiera monta el rAF loop).
 *
 * Integración: `<PerfOverlay />` en cualquier punto del árbol de la página
 * del juego (componente cliente). No requiere props para funcionar.
 */
export function PerfOverlay({ canvasRef }: PerfOverlayProps = {}): React.JSX.Element | null {
  const [enabled, setEnabled] = useState(false);
  const [stats, setStats] = useState<PerfStats>(INITIAL_STATS);
  const rafRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);
  const windowSumRef = useRef(0);

  useEffect(() => {
    setEnabled(isDevEnabled());
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let last = performance.now();

    const tick = (now: number) => {
      const dt = now - last;
      last = now;

      const frames = frameTimesRef.current;
      frames.push(dt);
      windowSumRef.current += dt;
      // Ventana móvil de ~1s: descarta muestras viejas por el frente.
      while (windowSumRef.current > 1000 && frames.length > 1) {
        windowSumRef.current -= frames.shift()!;
      }

      const avgMs = windowSumRef.current / frames.length;
      const fps = avgMs > 0 ? 1000 / avgMs : 0;

      const canvas = canvasRef?.current ?? document.querySelector("canvas");
      const canvasSize = canvas ? `${canvas.width}×${canvas.height}` : "–";
      const dpr = window.devicePixelRatio || 1;

      const perf = performance as PerformanceWithMemory;
      const memoryMb = perf.memory ? Math.round((perf.memory.usedJSHeapSize / 1048576) * 10) / 10 : null;

      setStats({
        fps: Math.round(fps),
        frameMs: Math.round(dt * 10) / 10,
        memoryMb,
        canvasSize,
        dpr,
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [enabled, canvasRef]);

  if (!enabled) return null;

  return (
    <div style={overlayStyle} aria-hidden="true">
      <div>
        FPS <span style={accentStyle}>{stats.fps}</span>
      </div>
      <div>{stats.frameMs.toFixed(1)} ms/frame</div>
      <div>MEM {stats.memoryMb !== null ? `${stats.memoryMb} MB` : "n/d"}</div>
      <div>CANVAS {stats.canvasSize}</div>
      <div>DPR {stats.dpr}</div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  left: 8,
  bottom: 8,
  zIndex: 9999,
  padding: "6px 10px",
  background: "rgba(20,23,38,.66)",
  color: "#ece7dd",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
  fontSize: 11,
  lineHeight: 1.5,
  borderRadius: 4,
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
};

const accentStyle: CSSProperties = {
  color: "#e3b063",
  fontWeight: 700,
};

export default PerfOverlay;
