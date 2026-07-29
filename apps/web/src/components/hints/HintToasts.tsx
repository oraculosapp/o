"use client";

import { useEffect, useRef, useState } from "react";
import type { WorldNetHooks } from "@/lib/realtime";
import { markOracleFound } from "@/lib/oracle-client";
import {
  FOUND_STORAGE_KEY,
  parseLastFoundAt,
  pickFoundMessage,
  shouldCelebrateFound,
} from "@/lib/paqo-found";
import { getOracle } from "@phygitalia/content";
import styles from "./hints.module.css";

export interface HintToastsProps {
  /** Oráculo cuyas pistas se muestran (default "paqo"). */
  oracleId?: string;
  /** Getter perezoso del world.net del engine (fuente de onZoneSignal). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
}

interface Toast {
  id: number;
  text: string;
  special?: boolean;
}

const MIN_GAP_MS = 45_000; // máx. 1 pista cada 45 s
const NET_RETRY_MS = 600;
const NET_RETRY_MAX = 20;
const TOAST_MS = 7_000;
/** El toast de ENCONTRAR se queda un poco más: es el premio, hay que leerlo. */
const FOUND_TOAST_MS = 9_500;
/** Duración del velo dorado de celebración (susurro, no fuegos artificiales). */
const VEIL_MS = 2_600;

/** Lee localStorage sin reventar en modo privado / SSR. */
function readLS(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    /* modo privado: la celebración vivirá sólo en memoria */
  }
}

/**
 * Pistas susurradas estilo "selbar": píldora glass flotante superior que entra y
 * sale con el easing de marca. Se conectan a `world.net.onZoneSignal`:
 *   far/mid/near → pistas de getOracle(id).hints, escalonadas y sin repetir.
 *   found        → CEREMONIA: toast especial en voz de Paqo + velo dorado +
 *                  progreso (si hay cuenta). Lo sonoro (acorde-campana + chispas)
 *                  ya lo pone el engine; aquí sólo la parte visual, discreta.
 *
 * La ceremonia se celebra UNA VEZ por sesión y con COOLDOWN por visita (ver
 * lib/paqo-found): entrar y salir del claro —o recargar— dentro de 2 min no la
 * repite. La lógica pura vive en lib/paqo-found.ts (y está testeada).
 */
export function HintToasts({ oracleId = "paqo", getWorldNet }: HintToastsProps) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const getNetRef = useRef(getWorldNet);
  getNetRef.current = getWorldNet;

  // Refs de estado que no deben provocar re-render.
  const hintsRef = useRef<string[]>([]);
  const usedRef = useRef<Set<number>>(new Set());
  const lastAtRef = useRef(0);
  const seqRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const veilTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Última celebración de ESTA sesión (gana a localStorage si es más reciente). */
  const celebratedAtRef = useRef<number | null>(null);
  /** Último mensaje de Paqo mostrado al encontrarlo (para no repetirlo). */
  const lastFoundMsgRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      hintsRef.current = getOracle(oracleId).hints ?? [];
    } catch {
      hintsRef.current = [];
    }
  }, [oracleId]);

  // Pista inicial de onboarding (t=0): al entrar al mundo, antes de cualquier
  // señal de zona, una sola pista con los controles. Una vez por dispositivo.
  useEffect(() => {
    const KEY = "phy:onboarded";
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return; // sin localStorage: no insistimos.
    }
    const t = setTimeout(() => {
      show("Muévete con WASD o el joystick · arrastra para mirar · busca el tótem.");
      try {
        localStorage.setItem(KEY, "1");
      } catch {
        /* noop */
      }
    }, 900); // deja respirar tras la carga del mundo
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const show = (text: string, special = false) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setLeaving(false);
    setToast({ id: ++seqRef.current, text, special });
    hideTimer.current = setTimeout(
      () => {
        setLeaving(true);
        leaveTimer.current = setTimeout(() => setToast(null), 320);
      },
      special ? FOUND_TOAST_MS : TOAST_MS
    );
  };

  const nextHint = (): string | null => {
    const hints = hintsRef.current;
    if (hints.length === 0) return null;
    if (usedRef.current.size >= hints.length) return null; // no repetir
    // Toma la primera pista aún no usada (escalonado por orden de aparición).
    for (let i = 0; i < hints.length; i++) {
      if (!usedRef.current.has(i)) {
        usedRef.current.add(i);
        return hints[i];
      }
    }
    return null;
  };

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    /** Ceremonia de ENCONTRAR (parte visual). Ver lib/paqo-found. */
    const celebrateFound = () => {
      const now = Date.now();
      // El instante de esta sesión manda sobre el persistido (puede ir por delante).
      const stored = parseLastFoundAt(readLS(FOUND_STORAGE_KEY));
      const last = Math.max(celebratedAtRef.current ?? 0, stored ?? 0) || null;
      if (!shouldCelebrateFound(last, now)) return;

      celebratedAtRef.current = now;
      writeLS(FOUND_STORAGE_KEY, String(now));

      const msg = pickFoundMessage(now, lastFoundMsgRef.current);
      lastFoundMsgRef.current = msg;
      show(msg, true);

      // Velo dorado: un respiro de luz cálida sobre el mundo, sin bloquear nada.
      if (veilTimer.current) clearTimeout(veilTimer.current);
      setCelebrating(true);
      veilTimer.current = setTimeout(() => setCelebrating(false), VEIL_MS);
    };

    const onSignal = (signal: "far" | "mid" | "near" | "found") => {
      if (signal === "found") {
        // El progreso se registra SIEMPRE (es idempotente y puede haber iniciado
        // sesión entre visitas); la ceremonia visual sí respeta el cooldown.
        void markOracleFound(oracleId);
        celebrateFound();
        return;
      }
      const now = Date.now();
      if (now - lastAtRef.current < MIN_GAP_MS) return; // cadencia máx. 1/45 s
      const hint = nextHint();
      if (!hint) return;
      lastAtRef.current = now;
      show(hint);
    };

    const wire = () => {
      if (cancelled) return;
      const net = getNetRef.current?.();
      if (!net) {
        if (retry < NET_RETRY_MAX) {
          retry += 1;
          retryTimer = setTimeout(wire, NET_RETRY_MS);
        }
        return;
      }
      unsub = net.onZoneSignal(onSignal);
    };
    wire();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (veilTimer.current) clearTimeout(veilTimer.current);
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleId]);

  if (!toast && !celebrating) return null;

  return (
    <>
      {celebrating && <div className={styles.veil} aria-hidden />}
      {toast && (
        <div className={styles.layer} aria-live="polite" role="status">
          <div
            key={toast.id}
            className={`${styles.toast} ${toast.special ? styles.toastFound : ""} ${
              leaving ? styles.leaving : styles.entering
            }`}
          >
            <span className={styles.glyph} aria-hidden>
              {toast.special ? "✧" : "◈"}
            </span>
            <span className={styles.text}>{toast.text}</span>
          </div>
        </div>
      )}
    </>
  );
}
