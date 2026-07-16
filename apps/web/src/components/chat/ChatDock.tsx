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
/** Estado de anclaje de la hoja inferior móvil (bottom sheet). */
type Snap = "peek" | "full";

const MODE_KEY = "phy:chatMode";
const POS_KEY = "phy:chatPos";
const MARGIN = 12;

/** Media query unificada de "móvil": puntero grueso O pantalla estrecha (problema 8). */
const COARSE_QUERY = "(pointer: coarse), (max-width: 640px)";
/**
 * Móvil en HORIZONTAL: la hoja vertical no sirve (poca altura), así que el chat pasa
 * a PANEL LATERAL IZQUIERDO. Sólo en dispositivos táctiles (pointer:coarse) para no
 * capturar un escritorio con ventana apaisada estrecha.
 */
const LANDSCAPE_QUERY = "(orientation: landscape) and (pointer: coarse)";
/** Fracciones de alto de la hoja (deben ir alineadas con .sheetPeek/.sheetFull en CSS). */
const PEEK_FRACTION = 0.42;
const FULL_FRACTION = 0.88;

interface Pos {
  x: number;
  y: number;
}

/**
 * ¿El HUD debe usar el layout móvil? Unifica puntero grueso y ancho estrecho en
 * una sola media query (problema 8) para que JS y CSS coincidan siempre. Reactivo
 * a rotación/cambio de dispositivo.
 */
function useIsMobileHud(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(COARSE_QUERY);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return mobile;
}

/**
 * ¿Móvil en HORIZONTAL? (orientación apaisada + puntero grueso). Cuando es true, el
 * chat se dibuja como PANEL LATERAL izquierdo en vez de hoja superior. Reactivo a la
 * rotación del dispositivo.
 */
function useIsLandscapeMobile(): boolean {
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(LANDSCAPE_QUERY);
    const apply = () => setLandscape(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return landscape;
}

/** Lectura síncrona de "móvil" para inicializar estado sin esperar al efecto. */
function isMobileNow(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(COARSE_QUERY).matches;
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
 * HUD de chat con cuatro disposiciones (según dispositivo/orientación):
 *   · ESCRITORIO — COLUMNA lateral derecha (por defecto): full-height. Empuja el
 *     juego con `world.setViewportInset({right})`; al cerrar/flotar vuelve a 0.
 *   · ESCRITORIO — FLOTANTE: panel arrastrable por su cabecera; recuerda posición.
 *   · MÓVIL PORTRAIT — HOJA SUPERIOR (top sheet): cuelga desde arriba con el asa
 *     ABAJO, para jugar abajo mientras se lee arriba. Dos anclajes (asomar ~42% /
 *     expandir ~88%) + arrastre. Empuja el juego con {top} (avatar en la franja
 *     inferior). Los botones de acción quedan abajo → no chocan.
 *   · MÓVIL LANDSCAPE — PANEL LATERAL izquierdo, angosto y full-height, colapsable.
 *     Empuja el juego con {left}. La hoja vertical no sirve en apaisado.
 *
 * Enter (con el foco fuera de un campo) abre el chat y enfoca el mensaje; Escape lo
 * colapsa. Cuando el input del chat gana foco, apaga el input del juego
 * (`world.setInputEnabled(false)`) para que escribir NO mueva el avatar; al perder
 * el foco, lo reactiva. Conserva dos canales, live-regions y accesibilidad. La
 * cabecera reserva `voiceSlot` para el componente de voz (lo inyecta el orquestador).
 */
export function ChatDock({ biosphereId, getWorldNet, getWorld, voiceSlot }: ChatDockProps) {
  const configured = isSupabaseConfigured();
  const isMobile = useIsMobileHud();
  const isLandscape = useIsLandscapeMobile();
  // Tres disposiciones móviles: PORTRAIT → hoja superior (top sheet); LANDSCAPE →
  // panel lateral izquierdo. (Escritorio: columna/flotante, más abajo.)
  const isTopSheet = isMobile && !isLandscape;
  const isSidePanel = isMobile && isLandscape;
  // En ESCRITORIO arranca abierto (columna lateral); en MÓVIL arranca COLAPSADO
  // para no abrir el teclado al entrar (problema 3). Escape colapsa; Enter reabre.
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<Mode>("column");
  const [pos, setPos] = useState<Pos | null>(null);
  // Anclaje de la hoja inferior en móvil: asoma (~40%) o expandida (~85%).
  const [snap, setSnap] = useState<Snap>("peek");
  const [tab, setTab] = useState<Tab>("open");
  const [showRegister, setShowRegister] = useState(false);
  const [autoFocusInput, setAutoFocusInput] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ open: null, paqo: null });
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // Última posición del flotante (sin depender del closure de estado, que puede
  // ir por detrás durante el arrastre) para persistirla con exactitud al soltar.
  const posRef = useRef<Pos | null>(null);
  // Arrastre vertical de la hoja móvil (se opera directo sobre el DOM por
  // rendimiento; sólo se confirma el anclaje en el pointerup).
  const sheetDragRef = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);

  // Restaura modo/posición del último uso y, en móvil, colapsa al arrancar (sólo
  // cliente). El colapso evita el teclado emergente al entrar (problema 3).
  useEffect(() => {
    setMode(loadMode());
    const p = loadPos();
    posRef.current = p;
    setPos(p);
    if (isMobileNow()) setOpen(false);
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

  // --- Toggle EXTERNO del chat (botón CHAT del menú superior) ------------------
  // El launcher flotante desapareció: el botón de CHAT del menú controla el chat por
  // EVENTOS de ventana (desacople, sin props compartidas):
  //   · "phy:toggle-chat"       → alterna abrir/colapsar (en móvil, la hoja asoma).
  //   · "phy:chat-open-query"   → el botón pide el estado actual al montar.
  //   · "phy:chat-open" {open}  → difundimos el estado para que el botón lo refleje.
  useEffect(() => {
    const emit = () =>
      window.dispatchEvent(new CustomEvent("phy:chat-open", { detail: { open } }));
    const onToggle = () => {
      if (open) {
        setOpen(false);
      } else {
        setAutoFocusInput(false);
        if (isTopSheet) setSnap("peek"); // la hoja siempre asoma primero, sin teclado
        setOpen(true);
      }
    };
    window.addEventListener("phy:toggle-chat", onToggle);
    window.addEventListener("phy:chat-open-query", emit);
    emit(); // difunde el estado actual en cada cambio (y al montar)
    return () => {
      window.removeEventListener("phy:toggle-chat", onToggle);
      window.removeEventListener("phy:chat-open-query", emit);
    };
  }, [open, isTopSheet]);

  // --- Empuje del viewport del juego + chrome móvil ---------------------------
  // Empuja el juego para centrar el avatar en el área visible y publica el alto
  // ocupado abajo en `--chat-sheet-h` (px) + `data-chat-sheet` en <html>, que los
  // botones de acción (MobileControls) leen para reubicarse. Con el chat ARRIBA
  // (top sheet) o a la IZQUIERDA (panel apaisado) el borde inferior queda libre, así
  // que los botones NO chocan (var a 0). En escritorio empuja por la derecha.
  const applyChrome = useCallback(() => {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    const world = getWorld?.();
    // OJO: no extraer el método pelón (pierde el `this` del mundo).
    const setInset = world?.setViewportInset ? world.setViewportInset.bind(world) : undefined;

    // MÓVIL HORIZONTAL: panel lateral IZQUIERDO (setViewportInset {left}). El borde
    // inferior queda libre (botones de acción abajo), así que --chat-sheet-h = 0.
    if (isSidePanel) {
      const vw = typeof window !== "undefined" ? window.innerWidth : 0;
      if (open) {
        const w = panelRef.current
          ? Math.round(panelRef.current.getBoundingClientRect().width)
          : Math.round(vw * 0.4);
        root?.style.setProperty("--chat-sheet-h", "0px");
        if (root) root.dataset.chatSheet = "side";
        setInset?.({ left: w, right: 0, top: 0, bottom: 0 });
      } else {
        root?.style.setProperty("--chat-sheet-h", "64px");
        if (root) root.dataset.chatSheet = "closed";
        setInset?.({ left: 0, right: 0, top: 0, bottom: 0 });
      }
      return;
    }

    // MÓVIL VERTICAL: HOJA SUPERIOR (top sheet). Cuelga desde arriba con {top}: el
    // avatar se recoloca en la franja visible INFERIOR (tope al 50% para no
    // aplastarlo al expandir). data-chat-sheet="top" (nunca "full") → los botones
    // de acción quedan visibles abajo, sin chocar con el chat.
    if (isTopSheet) {
      const vh = typeof window !== "undefined" ? window.innerHeight : 0;
      if (open) {
        const hPx = Math.round((snap === "full" ? FULL_FRACTION : PEEK_FRACTION) * vh);
        root?.style.setProperty("--chat-sheet-h", "0px");
        if (root) root.dataset.chatSheet = "top";
        setInset?.({ top: Math.min(hPx, Math.round(vh * 0.5)), right: 0, bottom: 0, left: 0 });
      } else {
        // Colapsado: reserva sitio para el launcher (los botones quedan por encima).
        root?.style.setProperty("--chat-sheet-h", "64px");
        if (root) root.dataset.chatSheet = "closed";
        setInset?.({ top: 0, right: 0, bottom: 0, left: 0 });
      }
      return;
    }

    // Escritorio: sin chrome móvil; empuje lateral en modo columna.
    root?.style.removeProperty("--chat-sheet-h");
    if (root) root.dataset.chatSheet = "closed";
    const right =
      open && mode === "column" && panelRef.current
        ? Math.round(panelRef.current.getBoundingClientRect().width)
        : 0;
    setInset?.({ right, bottom: 0, top: 0, left: 0 });
  }, [getWorld, isTopSheet, isSidePanel, open, mode, snap]);

  // Recalcula al abrir/cerrar, cambiar de modo/anclaje, redimensionar panel o
  // ventana. Al desmontar o cerrar, libera el empuje y limpia el chrome.
  useEffect(() => {
    applyChrome();
    const el = panelRef.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(applyChrome) : null;
    if (ro && el) ro.observe(el);
    window.addEventListener("resize", applyChrome);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", applyChrome);
    };
  }, [applyChrome]);

  useEffect(() => {
    return () => {
      // Al desmontar el dock, no dejes el juego empujado ni el chrome sucio.
      getWorld?.()?.setViewportInset?.({ top: 0, right: 0, bottom: 0, left: 0 });
      const root = typeof document !== "undefined" ? document.documentElement : null;
      root?.style.removeProperty("--chat-sheet-h");
      if (root) root.dataset.chatSheet = "closed";
    };
  }, [getWorld]);

  // --- Foco del chat ⇄ input del juego ----------------------------------------
  const onFocusIn = (e: React.FocusEvent) => {
    if (!isEditableTarget(e.target)) return;
    getWorld?.()?.setInputEnabled?.(false);
    // Al escribir en la hoja superior, expándela: máximo sitio sobre el teclado.
    // (El panel lateral apaisado no usa anclajes verticales.)
    if (isTopSheet) setSnap("full");
  };
  const onFocusOut = (e: React.FocusEvent) => {
    if (isEditableTarget(e.target)) getWorld?.()?.setInputEnabled?.(true);
  };

  // --- Arrastre vertical de la HOJA SUPERIOR (top sheet) ----------------------
  // Se manipula el alto directo sobre el DOM durante el gesto (sin re-render por
  // frame) y sólo se confirma el anclaje al soltar. Un toque limpio alterna
  // asomar⇄expandir; arrastrar hacia arriba por debajo del umbral la colapsa.
  const startSheetDrag = (e: React.PointerEvent) => {
    const el = panelRef.current;
    if (!el) return;
    el.classList.add(styles.dragging);
    sheetDragRef.current = {
      startY: e.clientY,
      startH: el.getBoundingClientRect().height,
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onSheetDrag = (e: React.PointerEvent) => {
    const d = sheetDragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    // Hoja SUPERIOR: el asa está ABAJO, así que arrastrar hacia ABAJO agranda (el
    // panel se extiende hacia el borde inferior). Anclada en top:0, basta con el alto.
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 4) d.moved = true;
    const vh = window.innerHeight;
    const h = Math.min(vh * 0.92, Math.max(vh * 0.12, d.startH + dy));
    el.style.height = `${h}px`;
    // El chat está arriba: el borde inferior sigue libre, no reservamos alto abajo.
    document.documentElement.style.setProperty("--chat-sheet-h", "0px");
  };
  const endSheetDrag = (e: React.PointerEvent) => {
    const d = sheetDragRef.current;
    const el = panelRef.current;
    if (!d || !el) return;
    sheetDragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
    const h = el.getBoundingClientRect().height;
    el.classList.remove(styles.dragging);
    el.style.height = ""; // vuelve al alto por clase (con transición)
    const vh = window.innerHeight;
    if (!d.moved) {
      setSnap((s) => (s === "peek" ? "full" : "peek")); // toque: alterna
      return;
    }
    if (h < vh * 0.26) {
      setOpen(false); // encogida por debajo del umbral: colapsa al launcher
      return;
    }
    setSnap(h > vh * 0.6 ? "full" : "peek");
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

  // Colapsado: NO hay launcher flotante. El chat se abre desde el botón de CHAT del
  // menú superior (evento "phy:toggle-chat") o con Enter. Aquí no se pinta nada.
  if (!open) return null;

  // Disposición según dispositivo/orientación:
  //   · PORTRAIT móvil → HOJA SUPERIOR (top sheet): cuelga desde arriba, asa abajo,
  //     con anclajes asomar/expandir. Se juega abajo mientras se lee arriba.
  //   · LANDSCAPE móvil → PANEL LATERAL izquierdo, angosto, full-height, colapsable.
  //   · Escritorio → columna lateral derecha o flotante.
  const floating = !isMobile && mode === "floating";
  const layoutClass = isSidePanel
    ? styles.sidePanel
    : isTopSheet
      ? `${styles.sheet} ${snap === "full" ? styles.sheetFull : styles.sheetPeek}`
      : floating
        ? styles.dockFloating
        : styles.dockColumn;
  const floatStyle =
    floating && pos ? { left: `${pos.x}px`, top: `${pos.y}px` } : undefined;

  return (
    <>
      <section
        ref={panelRef}
        className={`${styles.dock} ${layoutClass}`}
        style={floatStyle}
        role="region"
        aria-label={`Chat de la Biósfera ${biosphereId}`}
        onFocusCapture={onFocusIn}
        onBlurCapture={onFocusOut}
      >
        <header
          className={`${styles.header} ${floating ? styles.headerDraggable : ""}`}
          onPointerDown={floating ? startDrag : undefined}
          onPointerMove={floating ? onDrag : undefined}
          onPointerUp={floating ? endDrag : undefined}
          onPointerCancel={floating ? endDrag : undefined}
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
              Chat general
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
              Privado con Paqo
              {unregisteredHint && <span className={styles.tabSpark} aria-hidden>✦</span>}
            </button>
          </div>

          {/* Controles de VOZ en la cabecera. Si el orquestador inyecta un
              voiceSlot, tiene prioridad; si no, el chat monta VoiceControls con la
              identidad de useBiosphere. Como TODOS reciben un nombre aleatorio al
              entrar, el botón es directamente "Unirse a la voz" (sin leyendas
              confusas): mientras la sesión se prepara, VoiceControls lo muestra
              deshabilitado (enabled={hasSession}). El cambio de nombre vive en el
              nameChip del composer. */}
          <div className={styles.voiceSlot}>
            {voiceSlot ??
              (bio.sessionId ? (
                <VoiceControls
                  biosphereId={biosphereId}
                  identity={bio.sessionId}
                  displayName={bio.name ?? "Viajero"}
                  enabled={hasSession}
                />
              ) : null)}
          </div>

          <div className={styles.headerRight}>
            <span className={`${styles.dot} ${statusDot}`} title={`Conexión: ${bio.status}`} aria-hidden />
            {/* El conmutador columna/flotante no aplica a la hoja móvil. */}
            {!isMobile && (
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
            )}
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setOpen(false)}
              aria-label="Colapsar el chat"
              title="Colapsar el chat"
            >
              {/* Panel lateral apaisado → colapsa a la izquierda (◀). Hoja superior
                  portrait → cuelga de arriba, colapsar = SUBIR (▴). Escritorio columna
                  → baja (▾). Se decide por la clase/disposición activa. */}
              {isSidePanel ? "◀" : isTopSheet ? "▴" : "▾"}
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

        {/* Asa de arrastre de la HOJA SUPERIOR, ABAJO (cuelga desde arriba): tocar
            alterna asomar⇄expandir; arrastrar hacia abajo agranda y hacia arriba, si
            baja del umbral, la colapsa. Sólo en portrait; el panel lateral usa ◀. */}
        {isTopSheet && (
          <div
            className={styles.grabberWrap}
            role="button"
            tabIndex={0}
            aria-label={snap === "full" ? "Contraer el chat" : "Expandir el chat"}
            onPointerDown={startSheetDrag}
            onPointerMove={onSheetDrag}
            onPointerUp={endSheetDrag}
            onPointerCancel={endSheetDrag}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSnap((s) => (s === "peek" ? "full" : "peek"));
              }
            }}
          >
            <span className={styles.grabber} aria-hidden />
          </div>
        )}
      </section>

      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
    </>
  );
}
