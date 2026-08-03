"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { WorldNetHooks } from "@/lib/realtime";
import type { GetWorld } from "@/lib/world-ui";
import { markOracleFound } from "@/lib/oracle-client";
import {
  FOUND_STORAGE_KEY,
  parseLastFoundAt,
  pickGuideMessage,
  shouldCelebrateFound,
} from "@/lib/paqo-found";
import {
  QUEST_STORAGE_KEY,
  addFound,
  announceFind,
  isNewFind,
  isOracleId,
  parseFound,
  serializeFound,
  type OracleId,
} from "@/lib/oracle-quest";
import { getOracle } from "@phygitalia/content";
import styles from "./hints.module.css";

export interface HintToastsProps {
  /** Oráculo cuyas pistas se muestran (default "paqo"). */
  oracleId?: string;
  /** Getter perezoso del world.net del engine (fuente de onZoneSignal). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
  /** Getter perezoso del MUNDO (fuente de onOracleFound, el quest de los nueve). */
  getWorld?: GetWorld;
}

interface Toast {
  id: number;
  text: string;
  /** Ceremonia dorada de Paqo (found). */
  special?: boolean;
  /** Nombre del Oráculo recién conocido (se pinta destacado antes del texto). */
  name?: string;
  /** Color de su aro: tiñe el glifo y el borde de la píldora. */
  color?: string;
}

const MIN_GAP_MS = 45_000; // máx. 1 pista cada 45 s
const NET_RETRY_MS = 600;
const NET_RETRY_MAX = 20;
const TOAST_MS = 7_000;
/** El toast de ENCONTRAR se queda un poco más: es el premio, hay que leerlo. */
const FOUND_TOAST_MS = 9_500;
/** El de conocer a un Oráculo trae mini-historia: necesita un respiro más. */
const QUEST_TOAST_MS = 10_500;
/** Duración del velo dorado de celebración (susurro, no fuegos artificiales). */
const VEIL_MS = 2_600;
/**
 * Respiro antes de la coletilla del NOVENO: el descubrimiento primero se lee
 * solo, y ya después cae el "ya los conoces a todos". Dos toasts, no un ladrillo.
 */
const COMPLETE_DELAY_MS = 3_400;

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
 * sale con el easing de marca. Se conectan a dos fuentes del engine:
 *
 *   world.net.onZoneSignal
 *     far/mid/near → pistas de getOracle(id).hints, escalonadas y sin repetir.
 *     found        → PAQO COMO BRÚJULA: saludo + progreso del quest + una pista
 *                    hacia un Oráculo que aún no conoce (ver lib/paqo-found).
 *                    Velo dorado incluido. Lo sonoro (acorde-campana + chispas)
 *                    ya lo pone el engine; aquí sólo la parte visual, discreta.
 *
 *   world.onOracleFound
 *     EL QUEST: al acercarse a cualquiera de los nueve Oráculos desperdigados
 *     por la isla, se presenta con su nombre y su mini-historia, teñido con el
 *     color de su aro, y se apunta en localStorage. Si ya venía persistido de
 *     otra sesión NO se repite el toast (el aro lo enciende el engine igual).
 *     Al NOVENO cae además la celebración de quest completo.
 *
 * La ceremonia de Paqo se celebra UNA VEZ por sesión y con COOLDOWN por visita
 * (ver lib/paqo-found): entrar y salir del claro —o recargar— dentro de 2 min no
 * la repite. Toda la lógica pura vive en lib/paqo-found.ts y lib/oracle-quest.ts
 * (y está testeada).
 */
export function HintToasts({ oracleId = "paqo", getWorldNet, getWorld }: HintToastsProps) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const getNetRef = useRef(getWorldNet);
  getNetRef.current = getWorldNet;
  const getWorldRef = useRef(getWorld);
  getWorldRef.current = getWorld;

  // Refs de estado que no deben provocar re-render.
  const hintsRef = useRef<string[]>([]);
  const usedRef = useRef<Set<number>>(new Set());
  const lastAtRef = useRef(0);
  const seqRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const veilTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Última celebración de ESTA sesión (gana a localStorage si es más reciente). */
  const celebratedAtRef = useRef<number | null>(null);
  /** Último Oráculo al que Paqo mandó (para no repetir la misma pista). */
  const lastHintForRef = useRef<OracleId | null>(null);
  /** Oráculos ya conocidos. Se siembra de localStorage al montar. */
  const foundRef = useRef<Set<OracleId>>(new Set());

  useEffect(() => {
    try {
      hintsRef.current = getOracle(oracleId).hints ?? [];
    } catch {
      hintsRef.current = [];
    }
  }, [oracleId]);

  // Siembra del quest desde localStorage (tolera basura: ver parseFound).
  useEffect(() => {
    foundRef.current = parseFound(readLS(QUEST_STORAGE_KEY));
  }, []);

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

  const show = (text: string, special = false, extra?: { name?: string; color?: string }) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setLeaving(false);
    setToast({ id: ++seqRef.current, text, special, name: extra?.name, color: extra?.color });
    const ms = extra?.name ? QUEST_TOAST_MS : special ? FOUND_TOAST_MS : TOAST_MS;
    hideTimer.current = setTimeout(() => {
      setLeaving(true);
      leaveTimer.current = setTimeout(() => setToast(null), 320);
    }, ms);
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
    let unsubQuest: (() => void) | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    /** Velo dorado: un respiro de luz cálida sobre el mundo, sin bloquear nada. */
    const glow = () => {
      if (veilTimer.current) clearTimeout(veilTimer.current);
      setCelebrating(true);
      veilTimer.current = setTimeout(() => setCelebrating(false), VEIL_MS);
    };

    /** Ceremonia de ENCONTRAR A PAQO (parte visual). Ver lib/paqo-found. */
    const celebrateFound = () => {
      const now = Date.now();
      // El instante de esta sesión manda sobre el persistido (puede ir por delante).
      const stored = parseLastFoundAt(readLS(FOUND_STORAGE_KEY));
      const last = Math.max(celebratedAtRef.current ?? 0, stored ?? 0) || null;
      if (!shouldCelebrateFound(last, now)) return;

      celebratedAtRef.current = now;
      writeLS(FOUND_STORAGE_KEY, String(now));

      // Paqo ya no dice "ya llegaste conmigo": ahora es la brújula del quest y
      // manda al viajero hacia alguno de los nueve que aún no conoce.
      const guide = pickGuideMessage(foundRef.current, now, lastHintForRef.current);
      lastHintForRef.current = guide.hintFor;
      show(guide.text, true);
      glow();
    };

    /** EL QUEST: se acercó a uno de los nueve. */
    const onOracle = (rawId: string) => {
      if (!isOracleId(rawId)) return; // id que no es de los nueve: ni caso
      // Lo persistido manda: si otra pestaña o sesión ya lo apuntó, no repetimos.
      const known = parseFound(readLS(QUEST_STORAGE_KEY));
      for (const id of foundRef.current) known.add(id);
      if (!isNewFind(known, rawId)) {
        foundRef.current = known; // resincroniza y calla (el aro lo pone el engine)
        return;
      }

      const next = addFound(known, rawId);
      foundRef.current = next;
      writeLS(QUEST_STORAGE_KEY, serializeFound(next));

      const a = announceFind(next, rawId);
      show(a.story, true, { name: a.name, color: a.color });
      glow();

      // El NOVENO: primero que se lea el descubrimiento, y ya luego el cierre.
      if (a.celebration) {
        const msg = a.celebration;
        if (completeTimer.current) clearTimeout(completeTimer.current);
        completeTimer.current = setTimeout(() => {
          if (cancelled) return;
          show(msg, true);
          glow();
        }, COMPLETE_DELAY_MS);
      }
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
      // El quest cuelga del MUNDO, no de la red: se engancha en cuanto exista,
      // aunque `world.net` tarde (o no llegue nunca, sin multijugador).
      if (!unsubQuest) {
        const world = getWorldRef.current?.();
        if (world?.onOracleFound) unsubQuest = world.onOracleFound(onOracle);
      }
      if (!net || !unsubQuest) {
        if (retry < NET_RETRY_MAX) {
          retry += 1;
          retryTimer = setTimeout(wire, NET_RETRY_MS);
        }
        if (!net) return;
      }
      if (!unsub) unsub = net.onZoneSignal(onSignal);
    };
    wire();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (veilTimer.current) clearTimeout(veilTimer.current);
      if (completeTimer.current) clearTimeout(completeTimer.current);
      unsub?.();
      unsubQuest?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleId]);

  return (
    <>
      {celebrating && <div className={styles.veil} aria-hidden />}
      {/* A11Y (WCAG 4.1.3): la región viva es PERSISTENTE — el `<div role="status">`
          vive SIEMPRE en el DOM aunque no haya pista, y sólo entra y sale el toast de
          dentro. Antes el componente devolvía null sin pista y la región nacía CON su
          contenido ya puesto: varios lectores de pantalla no anuncian una live-region
          que aparece al mismo tiempo que su texto (necesitan observarla vacía antes
          para detectar el cambio), así que las pistas de Paqo podían no llegar nunca.
          Es el mismo patrón ya documentado en pwa/UpdateSentinel.
          El contenedor no estorba: `pointer-events: none` y, vacío, no pinta nada. */}
      <div className={styles.layer} aria-live="polite" role="status">
        {toast && (
          <div
            key={toast.id}
            className={`${styles.toast} ${toast.special ? styles.toastFound : ""} ${
              toast.color ? styles.toastQuest : ""
            } ${leaving ? styles.leaving : styles.entering}`}
            /* El color del aro del Oráculo entra como custom property: el CSS lo
               usa para el glifo y el borde y cae al dorado de la casa si no viene. */
            style={toast.color ? ({ "--oracle": toast.color } as CSSProperties) : undefined}
          >
            <span className={styles.glyph} aria-hidden>
              {toast.special ? "✧" : "◈"}
            </span>
            <span className={styles.text}>
              {toast.name && <strong className={styles.name}>{toast.name}</strong>}
              {toast.text}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
