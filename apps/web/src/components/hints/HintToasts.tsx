"use client";

import { useEffect, useRef, useState } from "react";
import type { WorldNetHooks } from "@/lib/realtime";
import { markOracleFound } from "@/lib/oracle-client";
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

/**
 * Pistas susurradas estilo "selbar": píldora glass flotante superior que entra y
 * sale con el easing de marca. Se conectan a `world.net.onZoneSignal`:
 *   far/mid/near → pistas de getOracle(id).hints, escalonadas y sin repetir.
 *   found        → toast especial + progreso (si registrado) + celebración sutil.
 */
export function HintToasts({ oracleId = "paqo", getWorldNet }: HintToastsProps) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  const getNetRef = useRef(getWorldNet);
  getNetRef.current = getWorldNet;

  // Refs de estado que no deben provocar re-render.
  const hintsRef = useRef<string[]>([]);
  const usedRef = useRef<Set<number>>(new Set());
  const lastAtRef = useRef(0);
  const seqRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      hintsRef.current = getOracle(oracleId).hints ?? [];
    } catch {
      hintsRef.current = [];
    }
  }, [oracleId]);

  const show = (text: string, special = false) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setLeaving(false);
    setToast({ id: ++seqRef.current, text, special });
    hideTimer.current = setTimeout(() => {
      setLeaving(true);
      leaveTimer.current = setTimeout(() => setToast(null), 320);
    }, TOAST_MS);
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

    const onSignal = (signal: "far" | "mid" | "near" | "found") => {
      if (signal === "found") {
        show("Lo encontraste. El tercer ojo te vio llegar.", true);
        void markOracleFound(oracleId);
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
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleId]);

  if (!toast) return null;

  return (
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
  );
}
