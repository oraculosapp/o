"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  getStoredConversationId,
  storeConversationId,
  streamOracle,
  type WireMessage,
} from "@/lib/oracle-client";
import styles from "./chat.module.css";

interface Turn {
  role: "user" | "oracle";
  content: string;
  pending?: boolean;
}

export interface PaqoChannelProps {
  biosphereId: string;
  registered: boolean;
  sessionId: string | null;
  accessToken: string | null;
  onRegisterClick(): void;
}

const GREETING = "Bienvenido a Phygitalia. Soy Paqo, el que recibe. ¿Qué te trajo hasta aquí?";

/** Canal PAQO (privado): conversación 1:1 con streaming token a token. */
export function PaqoChannel({
  biosphereId,
  registered,
  sessionId,
  accessToken,
  onRegisterClick,
}: PaqoChannelProps) {
  const [turns, setTurns] = useState<Turn[]>([{ role: "oracle", content: GREETING }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    setDraft("");

    const history: WireMessage[] = turns
      .filter((t) => !t.pending && t.content.trim().length > 0)
      // El saludo inicial es del oráculo pero no forma parte del hilo enviado.
      .slice(1)
      .map((t) => ({ role: t.role, content: t.content }));
    const wire: WireMessage[] = [...history, { role: "user", content: text }];

    setTurns((prev) => [...prev, { role: "user", content: text }, { role: "oracle", content: "", pending: true }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const conversationId = registered ? getStoredConversationId(biosphereId) ?? undefined : undefined;

    await streamOracle(
      {
        oracleId: "paqo",
        mode: "private",
        biosphereId,
        messages: wire,
        conversationId,
        accessToken: registered ? accessToken : null,
        sessionId: sessionId ?? undefined,
        signal: controller.signal,
      },
      {
        onMeta: (meta) => {
          if (registered && meta.conversationId) storeConversationId(biosphereId, meta.conversationId);
        },
        onDelta: (chunk) => {
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "oracle") next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });
        },
        onError: (message) => setError(message),
        onDone: () => {
          setTurns((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "oracle") next[next.length - 1] = { ...last, pending: false };
            return next;
          });
        },
      }
    );

    setBusy(false);
    abortRef.current = null;
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
          className={styles.input}
          placeholder="Cuéntale a Paqo…"
          value={draft}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Mensaje privado a Paqo"
        />
        <button className={styles.sendBtn} type="submit" disabled={!draft.trim() || busy}>
          {busy ? "…" : "Enviar"}
        </button>
      </form>
    </div>
  );
}
