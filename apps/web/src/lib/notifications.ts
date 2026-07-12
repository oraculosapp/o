/**
 * Cliente de navegador para las NOTIFICACIONES in-app (campanita del HUD).
 *
 * - `loadNotifications`: lista las del usuario, más recientes primero (RLS
 *   owner-only las acota).
 * - `markNotificationRead`: marca `read_at` (grant de columna: sólo read_at).
 * - `subscribeNotifications`: Realtime opcional (postgres_changes INSERT/UPDATE)
 *   para que nuevas notificaciones y marcas de leído lleguen en vivo.
 *
 * La sesión (anónima o registrada) se garantiza con `ensureAnonSession()`: todo
 * usuario que entra al mundo tiene user_id y recibe la bienvenida de Paqo.
 */
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { ensureAnonSession, getSupabaseBrowserClient } from "./supabase";
import { isSupabaseConfigured } from "./realtime";

export { isSupabaseConfigured };

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

/** Garantiza sesión y devuelve el user_id (anónimo o registrado). */
export async function ensureUserId(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const session = await ensureAnonSession();
    return session.user.id;
  } catch {
    return null;
  }
}

/** Carga las notificaciones del usuario (más recientes primero). */
export async function loadNotifications(limit = 30): Promise<Notification[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = getSupabaseBrowserClient();
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as Notification[];
  } catch {
    return [];
  }
}

/**
 * Marca una notificación como leída (idempotente: si ya lo estaba, no hace nada
 * en la BD). Devuelve true si la operación no falló.
 */
export async function markNotificationRead(id: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabaseBrowserClient();
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .is("read_at", null);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Suscripción Realtime a las notificaciones del usuario. Llama a `onInsert` con
 * cada nueva notificación y a `onUpdate` cuando cambia (p.ej. read_at). Devuelve
 * una función para cancelar. Barata: un solo canal filtrado por user_id.
 */
export function subscribeNotifications(
  userId: string,
  handlers: { onInsert?(n: Notification): void; onUpdate?(n: Notification): void }
): () => void {
  if (!isSupabaseConfigured()) return () => {};
  const supabase = getSupabaseBrowserClient();
  let channel: RealtimeChannel | null = null;
  try {
    channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (change: RealtimePostgresChangesPayload<Notification>) => {
          const row = change.new as Notification | undefined;
          if (row?.id) handlers.onInsert?.(row);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
        (change: RealtimePostgresChangesPayload<Notification>) => {
          const row = change.new as Notification | undefined;
          if (row?.id) handlers.onUpdate?.(row);
        }
      )
      .subscribe();
  } catch {
    return () => {};
  }
  return () => {
    if (channel) void supabase.removeChannel(channel);
  };
}
