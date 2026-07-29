"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getStoredConversationId,
  startOracleStream,
  storeConversationId,
  type WireMessage,
} from "@/lib/oracle-client";
import { SendIcon } from "./SendIcon";
import styles from "./chat.module.css";

export interface Turn {
  role: "user" | "oracle";
  content: string;
  pending?: boolean;
}

const GREETING = "Bienvenido a Phygitalia. Soy Paqo, el que recibe. ¿Qué te trajo hasta aquí?";

export interface PaqoConversationParams {
  biosphereId: string;
  registered: boolean;
  sessionId: string | null;
  accessToken: string | null;
}

/**
 * Estado de la conversación privada con Paqo. Vive ARRIBA (en ChatDock), no en
 * el canal: el canal se desmonta al cambiar de pestaña (General ⇄ Privado) y al
 * cerrar el dock, y con el estado dentro se perdía la conversación entera. Aquí
 * sobrevive a ambas cosas; sólo muere cuando muere el dock.
 */
export interface PaqoConversation {
  turns: Turn[];
  busy: boolean;
  error: string | null;
  /** Texto del último turno completo de Paqo, para la región aria-live. */
  announce: string;
  /** Envía un mensaje al Oráculo (no-op si está vacío o hay uno en vuelo). */
  send(text: string): Promise<void>;
}

/**
 * Hook de la conversación con Paqo. Además de subir el estado, CORTA el SSE en
 * vuelo al desmontar (antes el AbortController se guardaba pero nadie lo
 * abortaba: el stream seguía vivo hasta 30 s haciendo setState sobre un
 * componente muerto).
 */
export function usePaqoConversation(params: PaqoConversationParams): PaqoConversation {
  const [turns, setTurns] = useState<Turn[]>([{ role: "oracle", content: GREETING }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Anuncio para lectores de pantalla: el turno de Paqo se lee COMPLETO al
  // terminar el stream (no token a token).
  const [announce, setAnnounce] = useState("");

  const streamRef = useRef("");
  // Espejo de `turns` para leer el historial al enviar sin recrear `send` en cada
  // token (y sin closures viejos).
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // Igual con los parámetros: cambian (sesión, token) sin necesidad de recrear.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const cancelRef = useRef<(() => void) | null>(null);

  // Al desmontar el dock, corta el stream en vuelo.
  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || cancelRef.current) return; // uno en vuelo: ni cola ni pisotón
    const { biosphereId, registered, sessionId, accessToken } = paramsRef.current;

    setError(null);
    const history: WireMessage[] = turnsRef.current
      .filter((t) => !t.pending && t.content.trim().length > 0)
      // El saludo inicial es del oráculo pero no forma parte del hilo enviado.
      .slice(1)
      .map((t) => ({ role: t.role, content: t.content }));
    const wire: WireMessage[] = [...history, { role: "user", content: text }];

    setTurns((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "oracle", content: "", pending: true },
    ]);
    setBusy(true);
    streamRef.current = "";

    const conversationId = registered ? getStoredConversationId(biosphereId) ?? undefined : undefined;

    const handle = startOracleStream(
      {
        oracleId: "paqo",
        mode: "private",
        biosphereId,
        messages: wire,
        conversationId,
        accessToken: registered ? accessToken : null,
        sessionId: sessionId ?? undefined,
      },
      {
        onMeta: (meta) => {
          if (registered && meta.conversationId) storeConversationId(biosphereId, meta.conversationId);
        },
        onDelta: (chunk) => {
          streamRef.current += chunk;
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "oracle") next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });
        },
        onError: (message) => setError(message),
        onDone: () => {
          // Anuncia el turno completo una sola vez, al terminar.
          if (streamRef.current.trim()) setAnnounce(streamRef.current);
        },
      }
    );
    cancelRef.current = handle.cancel;

    try {
      await handle.done;
    } finally {
      cancelRef.current = null;
      setBusy(false);
      // Cierre del turno pase lo que pase (fin normal, error o corte): si quedó
      // vacío se retira la burbuja fantasma; si no, se le quita el cursor.
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "oracle" || !last.pending) return prev;
        if (last.content.trim().length === 0) return prev.slice(0, -1);
        const next = [...prev];
        next[next.length - 1] = { ...last, pending: false };
        return next;
      });
    }
  }, []);

  return { turns, busy, error, announce, send };
}

export interface PaqoChannelProps {
  /** Estado de la conversación, propiedad del dock (ver `usePaqoConversation`). */
  conversation: PaqoConversation;
  registered: boolean;
  onRegisterClick(): void;
  /** Al montar (chat abierto con Enter), enfoca el campo de mensaje. */
  autoFocusInput?: boolean;
}

/** Canal PAQO (privado): conversación 1:1 con streaming token a token. */
export function PaqoChannel({
  conversation,
  registered,
  onRegisterClick,
  autoFocusInput,
}: PaqoChannelProps) {
  const { turns, busy, error, announce, send } = conversation;
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Enfoca el campo de mensaje al abrir el chat con Enter.
  useEffect(() => {
    if (autoFocusInput) inputRef.current?.focus();
    // Sólo al montar: el chat monta este canal cada vez que se abre el dock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text);
  };

  return (
    <div className={styles.channel}>
      <div className={styles.paqoLog} ref={listRef}>
        {turns.map((t, i) => (
          <div
            key={i}
            className={`${styles.paqoTurn} ${t.role === "oracle" ? styles.paqoTurnOracle : styles.paqoTurnUser}`}
          >
            <span className={styles.paqoWho}>{t.role === "oracle" ? "Paqo" : "Tú"}</span>
            <p className={styles.paqoText}>
              {t.content}
              {t.pending && <span className={styles.caret} aria-hidden />}
            </p>
          </div>
        ))}
        {error && (
          <p className={styles.paqoError} role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Región viva oculta: lee el turno completo de Paqo al terminar el stream. */}
      <p className={styles.srOnly} aria-live="polite" role="status">
        {announce}
      </p>

      {!registered && (
        <button type="button" className={styles.invite} onClick={onRegisterClick}>
          <span className={styles.inviteSpark} aria-hidden>
            ✦
          </span>
          <span>
            <b>Regístrate</b> para que Paqo te recuerde de una visita a otra.
          </span>
        </button>
      )}

      <form className={styles.composer} onSubmit={submit}>
        <input
          ref={inputRef}
          className={styles.input}
          placeholder="Cuéntale a Paqo…"
          value={draft}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Mensaje privado a Paqo"
        />
        <button
          className={styles.sendBtn}
          type="submit"
          disabled={!draft.trim() || busy}
          aria-label="Enviar"
          title="Enviar"
        >
          {busy ? "…" : <SendIcon />}
        </button>
      </form>
    </div>
  );
}
