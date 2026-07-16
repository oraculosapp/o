"use client";

import { useEffect, useState } from "react";
import styles from "./chat-menu-button.module.css";

/**
 * ChatMenuButton — botón de CHAT del MENÚ superior (globo de diálogo). Reemplaza al
 * antiguo launcher flotante del ChatDock: alterna abrir/colapsar el chat.
 *
 * Desacople por EVENTOS de ventana (no hay props compartidas con el ChatDock):
 *   · click → despacha "phy:toggle-chat" (el ChatDock lo escucha y alterna `open`).
 *   · escucha "phy:chat-open" (detail {open}) para reflejar el estado (aria-pressed).
 *   · al montar despacha "phy:chat-open-query" para pedir el estado actual y
 *     sincronizarse aunque el ChatDock se hubiera montado antes.
 *
 * En móvil el chat sigue siendo hoja superior (top-sheet): este botón la abre igual.
 */
export function ChatMenuButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail;
      if (detail) setOpen(Boolean(detail.open));
    };
    window.addEventListener("phy:chat-open", onState as EventListener);
    // Pide el estado actual por si el ChatDock ya estaba montado.
    window.dispatchEvent(new Event("phy:chat-open-query"));
    return () => window.removeEventListener("phy:chat-open", onState as EventListener);
  }, []);

  const toggle = () => window.dispatchEvent(new Event("phy:toggle-chat"));

  return (
    <button
      type="button"
      className={`${styles.button} ${styles.tip}`}
      onClick={toggle}
      aria-pressed={open}
      aria-label={open ? "Colapsar el chat" : "Abrir el chat"}
      title={open ? "Cerrar chat" : "Chat"}
      data-tip={open ? "Cerrar chat" : "Chat"}
    >
      <ChatGlyph />
    </button>
  );
}

/** Glifo de globo de diálogo (trazo 1.6px currentColor, coherente con el set del HUD). */
function ChatGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 12.5c0 3.6-3.4 6.5-7.6 6.5-.9 0-1.8-.13-2.6-.37L4 20l1.1-3.3C4.4 15.5 4 14.05 4 12.5 4 8.9 7.4 6 11.6 6S20 8.9 20 12.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
