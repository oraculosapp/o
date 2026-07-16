"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BiosphereRealtime,
  isSupabaseConfigured,
  type BiosphereMessage,
  type RealtimeStatus,
  type RosterMember,
  type SessionErrorInfo,
  type WorldNetHooks,
} from "@/lib/realtime";
import type { WorldGameHooks } from "@/lib/world-ui";
import {
  getStoredName,
  mentionPaqoPublic,
  mentionsPaqo,
  pickTint,
  storeName,
} from "@/lib/oracle-client";

const DEFAULT_NAME = "Viajero";
const MAX_MESSAGES = 120;

export interface UseBiosphere {
  status: RealtimeStatus;
  messages: BiosphereMessage[];
  roster: RosterMember[];
  name: string | null;
  registered: boolean;
  sessionId: string | null;
  accessToken: string | null;
  /**
   * Causa AMABLE del fallo de sesión (incógnito / captcha / red / otro), o null si
   * no ha fallado. La UI la usa para el mensaje y para ofrecer "Reintentar".
   */
  sessionError: SessionErrorInfo | null;
  setName(name: string): void;
  /** Publica en el chat abierto; si menciona a Paqo, dispara su respuesta pública. */
  sendPublic(text: string): Promise<void>;
  /** Reintenta la conexión (botón "Reintentar" del estado de sesión fallida). */
  retryConnect(): void;
}

/**
 * Ata el ciclo de vida de `BiosphereRealtime` a React: conecta al montar,
 * limpia al desmontar, mantiene mensajes (con dedupe por id) y roster.
 */
export function useBiosphere(params: {
  biosphereId: string;
  getWorldNet?: () => WorldNetHooks | null | undefined;
  getWorldGame?: () => WorldGameHooks | null | undefined;
}): UseBiosphere {
  const { biosphereId, getWorldNet, getWorldGame } = params;
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [messages, setMessages] = useState<BiosphereMessage[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [name, setNameState] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<SessionErrorInfo | null>(null);

  const rtRef = useRef<BiosphereRealtime | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const getWorldNetRef = useRef(getWorldNet);
  getWorldNetRef.current = getWorldNet;
  const getWorldGameRef = useRef(getWorldGame);
  getWorldGameRef.current = getWorldGame;

  const pushMessage = useCallback((msg: BiosphereMessage) => {
    if (seenIds.current.has(msg.id)) return;
    seenIds.current.add(msg.id);
    setMessages((prev) => {
      const next = [...prev, msg].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
    });
  }, []);

  // Tras una conexión con éxito (montaje inicial O reintento manual): vuelca la
  // identidad y el historial reciente. Compartido para que "Reintentar" recupere
  // la sesión igual que el arranque, sin duplicar lógica.
  const afterConnect = useCallback(
    async (rt: BiosphereRealtime) => {
      const id = rt.getIdentity();
      if (id) {
        setSessionId(id.sessionId);
        setRegistered(id.registered);
        setAccessToken(id.accessToken);
      }
      const recent = await rt.loadRecent(40);
      for (const m of recent) pushMessage(m);
    },
    [pushMessage]
  );

  useEffect(() => {
    // Sin Supabase no hay nada que conectar (la UI ya muestra el aviso discreto).
    if (!isSupabaseConfigured()) {
      setNameState(getStoredName());
      return;
    }
    const initialName = getStoredName();
    setNameState(initialName);
    const tint = pickTint(biosphereId);

    const rt = new BiosphereRealtime({
      biosphereId,
      getWorldNet: () => getWorldNetRef.current?.(),
      getWorldGame: () => getWorldGameRef.current?.(),
      displayName: initialName ?? DEFAULT_NAME,
      tint,
      onStatus: setStatus,
      onRoster: setRoster,
      onMessage: pushMessage,
      onSessionError: setSessionError,
    });
    rtRef.current = rt;

    let cancelled = false;
    void rt.connect().then(() => {
      if (cancelled) return;
      void afterConnect(rt);
    });

    return () => {
      cancelled = true;
      rt.disconnect();
      rtRef.current = null;
      seenIds.current.clear();
    };
    // biosphereId es estable durante la vida de la página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biosphereId]);

  const setName = useCallback((next: string) => {
    const clean = next.trim().slice(0, 40);
    if (!clean) return;
    storeName(clean);
    setNameState(clean);
    void rtRef.current?.setIdentity({ displayName: clean });
  }, []);

  // Reintento manual: limpia el motivo mostrado y relanza la conexión; al terminar
  // vuelca identidad/historial igual que el arranque (afterConnect).
  const retryConnect = useCallback(() => {
    const rt = rtRef.current;
    if (!rt) return;
    setSessionError(null);
    void rt.retryConnect().then(() => afterConnect(rt));
  }, [afterConnect]);

  const sendPublic = useCallback(
    async (text: string) => {
      const rt = rtRef.current;
      if (!rt) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const row = await rt.sendMessage(trimmed);
      if (row) pushMessage(row); // eco optimista (postgres_changes deduplica)

      if (mentionsPaqo(trimmed)) {
        const id = rt.getIdentity();
        void mentionPaqoPublic({
          biosphereId,
          messages: [{ role: "user", content: trimmed }],
          sessionId: id?.sessionId,
          // El displayName del realtime ya es el nombre público del viajero
          // (nombre guardado o DEFAULT_NAME). Así Paqo puede dirigirse a la
          // persona por su nickname en el chat general.
          speakerName: id?.displayName ?? DEFAULT_NAME,
        });
      }
    },
    [biosphereId, pushMessage]
  );

  return {
    status,
    messages,
    roster,
    name,
    registered,
    sessionId,
    accessToken,
    sessionError,
    setName,
    sendPublic,
    retryConnect,
  };
}
