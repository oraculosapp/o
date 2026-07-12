"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureUserId,
  isSupabaseConfigured,
  loadNotifications,
  markNotificationRead,
  subscribeNotifications,
  type Notification,
} from "@/lib/notifications";
import styles from "./bell.module.css";

/**
 * Campanita del HUD (design system Phygitalia). Botón discreto tipo side-button
 * con badge dorado de no-leídas; al abrir, panel glass con la lista.
 *
 * REGLA DEL DIRECTOR: hover O click sobre cualquier parte de una notificación la
 * marca como leída (optimista: actualiza read_at local al instante y persiste en
 * segundo plano). Realtime opcional para nuevas notificaciones en vivo.
 */
export function Bell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Ids ya marcados en esta sesión: evita reenviar el update en cada hover.
  const markedRef = useRef<Set<string>>(new Set());

  const unread = items.reduce((n, it) => (it.read_at ? n : n + 1), 0);

  // Fusiona una fila (insert/update de Realtime) por id, más recientes primero.
  const mergeItem = useCallback((row: Notification) => {
    setItems((prev) => {
      const idx = prev.findIndex((p) => p.id === row.id);
      const next = idx >= 0 ? prev.map((p) => (p.id === row.id ? row : p)) : [row, ...prev];
      return next.sort((a, b) => b.created_at.localeCompare(a.created_at));
    });
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    let cancelled = false;
    let unsub: (() => void) | null = null;

    void (async () => {
      const userId = await ensureUserId();
      if (cancelled || !userId) return;
      const initial = await loadNotifications();
      if (cancelled) return;
      setItems(initial);
      setReady(true);
      unsub = subscribeNotifications(userId, {
        onInsert: mergeItem,
        onUpdate: mergeItem,
      });
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [mergeItem]);

  // Cierre al hacer clic fuera / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Marca una notificación como leída (optimista + persistencia en background).
  const markRead = useCallback((n: Notification) => {
    if (n.read_at || markedRef.current.has(n.id)) return;
    markedRef.current.add(n.id);
    const stamp = new Date().toISOString();
    setItems((prev) => prev.map((p) => (p.id === n.id ? { ...p, read_at: stamp } : p)));
    void markNotificationRead(n.id);
  }, []);

  // Sin Supabase configurado: no montamos nada (coherente con el ChatDock).
  if (!isSupabaseConfigured()) return null;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.bell}
        aria-label={
          unread > 0 ? `Notificaciones (${unread} sin leer)` : "Notificaciones"
        }
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BellGlyph />
        {unread > 0 && (
          <span className={styles.badge} aria-hidden>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Notificaciones">
          <header className={styles.panelHead}>
            <span className={styles.panelTitle}>Notificaciones</span>
            {unread > 0 && <span className={styles.panelCount}>{unread}</span>}
          </header>

          <ul className={styles.list}>
            {items.length === 0 ? (
              <li className={styles.empty}>
                {ready ? "Todo tranquilo por ahora." : "Cargando…"}
              </li>
            ) : (
              items.map((n) => (
                <li
                  key={n.id}
                  className={`${styles.item} ${n.read_at ? styles.itemRead : styles.itemUnread}`}
                  onMouseEnter={() => markRead(n)}
                  onClick={() => {
                    markRead(n);
                    if (n.link) window.location.assign(n.link);
                  }}
                >
                  {!n.read_at && <span className={styles.itemDot} aria-hidden />}
                  <div className={styles.itemBody}>
                    <p className={styles.itemTitle}>{n.title}</p>
                    {n.body && <p className={styles.itemText}>{n.body}</p>}
                    <time className={styles.itemTime} dateTime={n.created_at}>
                      {formatWhen(n.created_at)}
                    </time>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Glifo de campana (trazo 1.6px currentColor, coherente con el set de iconos). */
function BellGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3.5c-3 0-5 2.2-5 5.2 0 4-1.4 5.2-2 6.1-.3.5 0 1.2.7 1.2h12.6c.7 0 1-.7.7-1.2-.6-.9-2-2.1-2-6.1 0-3-2-5.2-5-5.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Fecha relativa amable en español (sin dependencias). */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}
