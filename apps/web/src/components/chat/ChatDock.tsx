"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { WorldNetHooks } from "@/lib/realtime";
import { isSupabaseConfigured } from "@/lib/realtime";
import type { GetWorld } from "@/lib/world-ui";
import { RegisterModal } from "@/components/auth/RegisterModal";
import { useBiosphere } from "./useBiosphere";
import { OpenChannel } from "./OpenChannel";
import { PaqoChannel } from "./PaqoChannel";
import styles from "./chat.module.css";

/**
 * Controles de VOZ integrados en la cabecera del chat. Import dinámico con
 * `ssr:false` para no romper el render si el módulo de voz se está reescribiendo
 * (degrada solo: si el import falla, la cabecera sigue funcionando). El contrato
 * estable del componente es `{ biosphereId, identity, displayName }`.
 */
const VoiceControls = dynamic(
  () => import("@/components/voice/VoiceControls").then((m) => m.VoiceControls),
  { ssr: false },
);

export interface ChatDockProps {
  biosphereId: string;
  /** Getter perezoso del world.net del engine (opcional; el chat funciona sin él). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
  /**
   * Getter perezoso del MUNDO (para setViewportInset / setInputEnabled). Opcional:
   * si falta o el método aún no existe, el chat degrada con gracia.
   */
  getWorld?: GetWorld;
  /**
   * Slot en la cabecera para los controles de VOZ. El orquestador inyecta aquí el
   * componente del equipo de voz; el chat sólo reserva el espacio.
   */
  voiceSlot?: ReactNode;
}

type Tab = "open" | "paqo";
type Mode = "column" | "floating";

const MODE_KEY = "phy:chatMode";
const POS_KEY = "phy:chatPos";
const MARGIN = 12;

interface Pos {
  x: number;
  y: number;
}

/** ¿El foco está en un campo de texto? (para no secuestrar Enter del juego/chat). */
function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable === true
  );
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "column";
  return window.localStorage.getItem(MODE_KEY) === "floating" ? "floating" : "column";
}

function loadPos(): Pos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return typeof p?.x === "number" && typeof p?.y === "number" ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

/** Mantiene un panel de wxh dentro del viewport. */
function clampPos(p: Pos, w: number, h: number): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
  return {
    x: Math.min(Math.max(MARGIN, p.x), maxX),
    y: Math.min(Math.max(MARGIN, p.y), maxY),
  };
}

/**
 * HUD de chat con dos disposiciones:
 *   · COLUMNA lateral derecha (por defecto): full-height. Mientras está abierta,
 *     empuja el juego con `world.setViewportInset({right})` para que el avatar
 *     quede centrado en el área visible; al cerrar/flotar vuelve a {right:0}.
 *   · FLOTANTE: panel arrastrable por su cabecera; recuerda posición en
 *     localStorage y se mantiene dentro del viewport.
 *
 * Enter (con el foco fuera de un campo) abre el chat y enfoca el mensaje; Escape lo
 * colapsa. Cuando el input del chat gana foco, apaga el input del juego
 * (`world.setInputEnabled(false)`) para que escribir NO mueva el avatar; al perder
 * el foco, lo reactiva. Conserva dos canales, live-regions y accesibilidad. La
 * cabecera reserva `voiceSlot` para el componente de voz (lo inyecta el orquestador).
 */
export function ChatDock({ biosphereId, getWorldNet, getWorld, voiceSlot }: ChatDockProps) {
  const configured = isSupabaseConfigured();
  // Arranca ABIERTO como columna lateral (requisito). Escape lo colapsa al
  // launcher; Enter lo reabre.
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<Mode>("column");
  const [pos, setPos] = useState<Pos | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [showRegister, setShowRegister] = useState(false);
  const [autoFocusInput, setAutoFocusInput] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ open: null, paqo: null });
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // Última posición del flotante (sin depender del closure de estado, que puede
  // ir por detrás durante el arrastre) para persistirla con exactitud al soltar.
  const posRef = useRef<Pos | null>(null);

  // Restaura modo/posición del último uso (sólo cliente).
  useEffect(() => {
    setMode(loadMode());
    const p = loadPos();
    posRef.current = p;
    setPos(p);
  }, []);

  // Enter (foco fuera de un campo) abre el chat y enfoca el mensaje; Escape lo
  // colapsa. El listener global se ignora si el foco ya está en un campo de texto
  // (así no rompe ni el input del chat ni el movimiento WASD del juego).
  useEffect(() => {
    if (!configured) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !open && !isEditableTarget(e.target)) {
        e.preventDefault();
        setAutoFocusInput(true);
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configured, open]);

  // --- Empuje del viewport del juego (avatar centrado en el área visible) ------
  const applyInset = useCallback(() => {
    const world = getWorld?.();
    if (!world?.setViewportInset) return;
    const right =
      open && mode === "column" && panelRef.current
        ? Math.round(panelRef.current.getBoundingClientRect().width)
        : 0;
    world.setViewportInset({ right });
  }, [getWorld, open, mode]);

  // Recalcula el inset al abrir/cerrar, cambiar de modo, redimensionar el panel o
  // la ventana. Al desmontar o cerrar, libera ({right:0}).
  useEffect(() => {
    applyInset();
    const el = panelRef.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(applyInset) : null;
    if (ro && el) ro.observe(el);
    window.addEventListener("resize", applyInset);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", applyInset);
    };
  }, [applyInset]);

  useEffect(() => {
    return () => {
      // Al desmontar el dock, no dejes el juego empujado.
      getWorld?.()?.setViewportInset?.({ right: 0 });
    };
  }, [getWorld]);

  // --- Foco del chat ⇄ input del juego ----------------------------------------
  const onFocusIn = (e: React.FocusEvent) => {
    if (isEditableTarget(e.target)) getWorld?.()?.setInputEnabled?.(false);
  };
  const onFocusOut = (e: React.FocusEvent) => {
    if (isEditableTarget(e.target)) getWorld?.()?.setInputEnabled?.(true);
  };

  // --- Arrastre del panel flotante --------------------------------------------
  const startDrag = (e: React.PointerEvent) => {
    if (mode !== "floating" || !panelRef.current) return;
    // No arrastres si se pulsó un control interactivo de la cabecera.
    if ((e.target as HTMLElement).closest("button,[role=tab],input,a")) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* puntero no activo (eventos sintéticos): el arrastre sigue por listeners */
    }
    e.preventDefault();
  };
  const onDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    const next = clampPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, el.offsetWidth, el.offsetHeight);
    posRef.current = next;
    setPos(next);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
    if (posRef.current) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(posRef.current));
      } catch {
        /* cuota/priv: no crítico */
      }
    }
  };

  // Reclampa el flotante al redimensionar la ventana.
  useEffect(() => {
    if (mode !== "floating") return;
    const onResize = () => {
      const el = panelRef.current;
      if (el && pos)
        setPos((p) => {
          if (!p) return p;
          const c = clampPos(p, el.offsetWidth, el.offsetHeight);
          posRef.current = c;
          return c;
        });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mode, pos]);

  const setModePersisted = (next: Mode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* noop */
    }
    if (next === "floating") {
      // Posición inicial sensata si no hay una guardada.
      setPos((p) => {
        if (p) {
          posRef.current = p;
          return p;
        }
        const el = panelRef.current;
        const w = el?.offsetWidth ?? 340;
        const h = el?.offsetHeight ?? 460;
        const initial = clampPos({ x: window.innerWidth - w - MARGIN, y: 72 }, w, h);
        posRef.current = initial;
        return initial;
      });
    }
  };

  // Roving tabindex + flechas entre pestañas (patrón WAI-ARIA tabs).
  const onTabsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order: Tab[] = ["open", "paqo"];
    const idx = order.indexOf(tab);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else return;
    e.preventDefault();
    setTab(order[next]);
    tabRefs.current[order[next]]?.focus();
  };

  // El hook siempre se llama (regla de hooks); si no hay Supabase, no conecta.
  // El mini-juego (world.game) se engancha al MISMO canal aquí, sin segunda
  // suscripción: GameHud sólo pinta; la difusión de eventos vive en la capa de red.
  const bio = useBiosphere({
    biosphereId,
    getWorldNet,
    getWorldGame: () => getWorld?.()?.game,
  });

  if (!configured) {
    return (
      <div className={styles.disabledNote} role="note">
        Chat en reposo · falta configurar Supabase
      </div>
    );
  }

  const statusDot =
    bio.status === "live"
      ? styles.dotLive
      : bio.status === "error"
        ? styles.dotError
        : styles.dotIdle;

  const unregisteredHint = tab === "paqo" && !bio.registered;

  // La voz sólo se habilita si el viajero ya se identificó (nombre + sesión).
  const hasSession = Boolean(bio.sessionId && bio.name);

  const openDock = () => {
    setAutoFocusInput(false);
    setOpen(true);
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.launcher}
        onClick={openDock}
        aria-label="Abrir chat y voz (o pulsa Enter)"
      >
        <span className={`${styles.dot} ${statusDot}`} aria-hidden />
        <span className={styles.launcherLabel}>Chat y voz</span>
        {bio.roster.length > 0 && (
          <span className={styles.launcherCount}>{bio.roster.length}</span>
        )}
      </button>
    );
  }

  const floating = mode === "floating";
  const floatStyle =
    floating && pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined;

  return (
    <>
      <section
        ref={panelRef}
        className={`${styles.dock} ${floating ? styles.dockFloating : styles.dockColumn}`}
        style={floatStyle}
        role="region"
        aria-label={`Chat de la Biósfera ${biosphereId}`}
        onFocusCapture={onFocusIn}
        onBlurCapture={onFocusOut}
      >
        <header
          className={`${styles.header} ${floating ? styles.headerDraggable : ""}`}
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className={styles.tabs} role="tablist" aria-label="Canales de chat" onKeyDown={onTabsKey}>
            <button
              id="chat-tab-open"
              role="tab"
              aria-selected={tab === "open"}
              aria-controls="chat-panel-open"
              tabIndex={tab === "open" ? 0 : -1}
              ref={(el) => {
                tabRefs.current.open = el;
              }}
              className={`${styles.tab} ${tab === "open" ? styles.tabActive : ""}`}
              onClick={() => setTab("open")}
            >
              Abierto
              {bio.roster.length > 0 && <span className={styles.tabCount}>{bio.roster.length}</span>}
            </button>
            <button
              id="chat-tab-paqo"
              role="tab"
              aria-selected={tab === "paqo"}
              aria-controls="chat-panel-paqo"
              tabIndex={tab === "paqo" ? 0 : -1}
              ref={(el) => {
                tabRefs.current.paqo = el;
              }}
              className={`${styles.tab} ${tab === "paqo" ? styles.tabActive : ""}`}
              onClick={() => setTab("paqo")}
            >
              Paqo
              {unregisteredHint && <span className={styles.tabSpark} aria-hidden>✦</span>}
            </button>
          </div>

          {/* Controles de VOZ en la cabecera. Si el orquestador inyecta un
              voiceSlot, tiene prioridad; si no, el chat monta VoiceControls con la
              identidad de useBiosphere. Sin sesión (aún sin nombre) muestra un
              aviso deshabilitado en vez de la voz, para no unir a un anónimo. */}
          <div className={styles.voiceSlot}>
            {voiceSlot ??
              (hasSession ? (
                <VoiceControls
                  biosphereId={biosphereId}
                  identity={bio.sessionId as string}
                  displayName={bio.name as string}
                />
              ) : (
                <button
                  type="button"
                  className={styles.voiceHint}
                  disabled
                  aria-disabled="true"
                  title="Escribe tu nombre en el chat para unirte a la voz"
                >
                  Voz · escribe tu nombre
                </button>
              ))}
          </div>

          <div className={styles.headerRight}>
            <span className={`${styles.dot} ${statusDot}`} title={`Conexión: ${bio.status}`} aria-hidden />
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setModePersisted(floating ? "column" : "floating")}
              aria-label={floating ? "Anclar el chat a la columna" : "Soltar el chat (flotante)"}
              aria-pressed={floating}
              title={floating ? "Anclar a la columna" : "Modo flotante"}
            >
              {floating ? "⇥" : "⧉"}
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setOpen(false)}
              aria-label="Colapsar el chat"
            >
              ▾
            </button>
          </div>
        </header>

        <div
          className={styles.body}
          role="tabpanel"
          id={tab === "open" ? "chat-panel-open" : "chat-panel-paqo"}
          aria-labelledby={tab === "open" ? "chat-tab-open" : "chat-tab-paqo"}
        >
          {tab === "open" ? (
            <OpenChannel
              messages={bio.messages}
              name={bio.name}
              sessionId={bio.sessionId}
              onSetName={bio.setName}
              onSend={bio.sendPublic}
              autoFocusInput={autoFocusInput}
            />
          ) : (
            <PaqoChannel
              biosphereId={biosphereId}
              registered={bio.registered}
              sessionId={bio.sessionId}
              accessToken={bio.accessToken}
              onRegisterClick={() => setShowRegister(true)}
              autoFocusInput={autoFocusInput}
            />
          )}
        </div>
      </section>

      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
    </>
  );
}
