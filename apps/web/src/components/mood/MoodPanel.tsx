"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldUiHooks } from "@/lib/world-ui";
import styles from "./mood.module.css";

export interface MoodPanelProps {
  /** Getter perezoso del MUNDO (para world.setMood/setWeather). Degrada si aún no existe. */
  getWorld: () => WorldUiHooks | null;
}

/**
 * MoodPanel — panel discreto de "mood" (color grading) y clima de la biósfera
 * (equipo Atmos). Píldora glass en el clúster superior-izquierda que abre un
 * panel de cristal con dos filas de chips: Ánimo (7 looks de LUT) y Clima (5
 * presets). Las elecciones llaman a `world.setMood(id)` / `world.setWeather(id)`
 * con optional-chaining y se PERSISTEN en localStorage (`phy:mood`/`phy:weather`),
 * re-aplicándose al montar en cuanto el mundo existe (getWorld puede ser null al
 * principio: se reintenta ~600 ms hasta ~12 s, como lib/realtime.ts).
 */

const MOODS = [
  ["natural", "Natural"],
  ["calido", "Cálido"],
  ["frio", "Frío"],
  ["drama", "Drama"],
  ["cine", "Cine"],
  ["vivo", "Vivo"],
  ["brillante", "Brillante"],
] as const;

const WEATHERS = [
  ["pradera", "Pradera"],
  ["bruma", "Bruma"],
  ["ocaso", "Ocaso"],
  ["cenit", "Cenit"],
  ["tormenta", "Tormenta"],
] as const;

type MoodId = (typeof MOODS)[number][0];
type WeatherId = (typeof WEATHERS)[number][0];

const MOOD_KEY = "phy:mood";
const WEATHER_KEY = "phy:weather";
const DEFAULT_MOOD: MoodId = "natural";
const DEFAULT_WEATHER: WeatherId = "pradera";

// Reintento de enganche al mundo (mismo patrón que lib/realtime.ts): ~600 ms
// hasta ~12 s, por si el engine aún no ha montado PaqoWorld al abrir la página.
const RETRY_MS = 600;
const RETRY_MAX = 20;

const isMood = (v: string | null): v is MoodId =>
  !!v && MOODS.some(([id]) => id === v);
const isWeather = (v: string | null): v is WeatherId =>
  !!v && WEATHERS.some(([id]) => id === v);

function readStored<T extends string>(key: string, guard: (v: string | null) => v is T, fallback: T): T {
  try {
    const v = window.localStorage?.getItem(key);
    return guard(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* almacenamiento no disponible → sólo se pierde la persistencia */
  }
}

export function MoodPanel({ getWorld }: MoodPanelProps) {
  const [open, setOpen] = useState(false);
  const [mood, setMood] = useState<MoodId>(DEFAULT_MOOD);
  const [weather, setWeather] = useState<WeatherId>(DEFAULT_WEATHER);
  const rootRef = useRef<HTMLDivElement>(null);

  // Al montar: lee las preferencias y las re-aplica en cuanto exista el mundo.
  useEffect(() => {
    const m = readStored(MOOD_KEY, isMood, DEFAULT_MOOD);
    const w = readStored(WEATHER_KEY, isWeather, DEFAULT_WEATHER);
    setMood(m);
    setWeather(w);

    let tries = 0;
    const timer = setInterval(() => {
      const world = getWorld();
      if (world) {
        world.setMood?.(m);
        world.setWeather?.(w);
        clearInterval(timer);
      } else if (++tries >= RETRY_MAX) {
        clearInterval(timer);
      }
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [getWorld]);

  // Cierra con Escape y con clic fuera del panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const pickMood = useCallback(
    (id: MoodId) => {
      setMood(id);
      writeStored(MOOD_KEY, id);
      getWorld()?.setMood?.(id);
    },
    [getWorld],
  );

  const pickWeather = useCallback(
    (id: WeatherId) => {
      setWeather(id);
      writeStored(WEATHER_KEY, id);
      getWorld()?.setWeather?.(id);
    },
    [getWorld],
  );

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.button} ${styles.tip}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Ánimo y clima"
        data-tip="Ánimo y clima"
      >
        <PaletteGlyph />
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Ánimo y clima">
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Ánimo</legend>
            <div className={styles.chips}>
              {MOODS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={styles.chip}
                  aria-pressed={mood === id}
                  onClick={() => pickMood(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Clima</legend>
            <div className={styles.chips}>
              {WEATHERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={styles.chip}
                  aria-pressed={weather === id}
                  onClick={() => pickWeather(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}

/** Glifo de paleta/atmósfera (trazo 1.6px currentColor, mismo lenguaje que el HUD). */
function PaletteGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5c-4.7 0-8.5 3.4-8.5 7.6 0 2.5 2 4.2 4.4 4.2 1.6 0 2.3 1 2.3 2.1 0 1.6 1.1 3.1 1.8 3.1 4.7 0 8.5-3.8 8.5-8.5S16.7 3.5 12 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="8.5" cy="9" r="1.15" fill="currentColor" />
      <circle cx="12.4" cy="7.4" r="1.15" fill="currentColor" />
      <circle cx="16" cy="9.6" r="1.15" fill="currentColor" />
    </svg>
  );
}
