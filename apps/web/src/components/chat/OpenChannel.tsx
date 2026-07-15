"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BiosphereMessage } from "@/lib/realtime";
import { MessageRow } from "./MessageRow";
import styles from "./chat.module.css";

export interface OpenChannelProps {
  messages: BiosphereMessage[];
  name: string | null;
  sessionId: string | null;
  onSetName(name: string): void;
  onSend(text: string): void | Promise<void>;
  /** Al montar (chat abierto con Enter), enfoca el campo de mensaje. */
  autoFocusInput?: boolean;
}

/** Canal ABIERTO: chat público de la Biósfera. Menciona a Paqo con "@paqo". */
export function OpenChannel({ messages, name, sessionId, onSetName, onSend, autoFocusInput }: OpenChannelProps) {
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true);

  // Enfoca el campo de mensaje al abrir el chat con Enter (si ya hay nombre).
  useEffect(() => {
    if (autoFocusInput && name) inputRef.current?.focus();
    // Sólo al montar: el chat monta este canal cada vez que se abre el dock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoscroll sólo si el usuario ya estaba abajo (no interrumpe la lectura).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (name) setEditingName(false);
  }, [name]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  const commitName = () => {
    const clean = nameDraft.trim();
    if (clean) {
      onSetName(clean);
      setEditingName(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (!name) {
      // Aún sin nombre: pedimos identidad antes de publicar.
      setEditingName(true);
      return;
    }
    void onSend(text);
    setDraft("");
    nearBottom.current = true;
  };

  const needsName = !name || editingName;

  return (
    <div className={styles.channel}>
      {messages.length === 0 ? (
        <div className={styles.empty}>
          <p>Aún no hay ecos en este claro.</p>
          <p className={styles.emptyHint}>
            Saluda, o llama a Paqo escribiendo <b>@paqo</b>.
          </p>
        </div>
      ) : (
        <ul
          className={styles.list}
          ref={listRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-label="Mensajes del canal abierto"
        >
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              displayName={m.display_name}
              content={m.content}
              isOracle={m.is_oracle}
              mine={!m.is_oracle && !!sessionId && m.user_id === sessionId}
              createdAt={m.created_at}
            />
          ))}
        </ul>
      )}

      {needsName ? (
        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            commitName();
          }}
        >
          <input
            className={styles.input}
            placeholder="¿Cómo te llamas, viajero?"
            value={nameDraft}
            maxLength={40}
            /* Sólo autofoco cuando el chat se abrió a propósito con Enter (escritorio);
               en móvil evita el teclado emergente al entrar (problema 3). */
            autoFocus={autoFocusInput}
            onChange={(e) => setNameDraft(e.target.value)}
            aria-label="Tu nombre para el chat"
          />
          <button className={styles.sendBtn} type="submit" disabled={!nameDraft.trim()}>
            Listo
          </button>
        </form>
      ) : (
        <form className={styles.composer} onSubmit={submit}>
          <button
            type="button"
            className={styles.nameChip}
            onClick={() => {
              setNameDraft(name);
              setEditingName(true);
            }}
            title="Cambiar tu nombre"
            aria-label={`Cambiar tu nombre (actual: ${name})`}
          >
            <span className={styles.nameChipText}>{name}</span>
            <span className={styles.nameChipPencil} aria-hidden>
              ✎
            </span>
          </button>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Escribe en el claro… (@paqo para llamarlo)"
            value={draft}
            maxLength={280}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Mensaje al chat abierto"
          />
          <button className={styles.sendBtn} type="submit" disabled={!draft.trim()}>
            Enviar
          </button>
        </form>
      )}
    </div>
  );
}
