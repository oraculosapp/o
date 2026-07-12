"use client";

import { useState } from "react";
import type { WorldNetHooks } from "@/lib/realtime";
import { isSupabaseConfigured } from "@/lib/realtime";
import { RegisterModal } from "@/components/auth/RegisterModal";
import { useBiosphere } from "./useBiosphere";
import { OpenChannel } from "./OpenChannel";
import { PaqoChannel } from "./PaqoChannel";
import styles from "./chat.module.css";

export interface ChatDockProps {
  biosphereId: string;
  /** Getter perezoso del world.net del engine (opcional; el chat funciona sin él). */
  getWorldNet?: () => WorldNetHooks | null | undefined;
}

type Tab = "open" | "paqo";

/**
 * HUD de chat: dock inferior-izquierdo colapsable con dos canales (Abierto /
 * Paqo). En móvil se comporta como hoja inferior. Si Supabase no está
 * configurado, no monta nada (aviso discreto). Ver docs/investigacion §4.
 */
export function ChatDock({ biosphereId, getWorldNet }: ChatDockProps) {
  const configured = isSupabaseConfigured();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("open");
  const [showRegister, setShowRegister] = useState(false);

  // El hook siempre se llama (regla de hooks); si no hay Supabase, no conecta.
  const bio = useBiosphere({ biosphereId, getWorldNet });

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

  if (!open) {
    return (
      <button
        type="button"
        className={styles.launcher}
        onClick={() => setOpen(true)}
        aria-label="Abrir el chat"
      >
        <span className={`${styles.dot} ${statusDot}`} aria-hidden />
        <span className={styles.launcherLabel}>Chat</span>
        {bio.roster.length > 0 && (
          <span className={styles.launcherCount}>{bio.roster.length}</span>
        )}
      </button>
    );
  }

  return (
    <>
      <section
        className={styles.dock}
        role="region"
        aria-label={`Chat de la Biósfera ${biosphereId}`}
      >
        <header className={styles.header}>
          <div className={styles.tabs} role="tablist">
            <button
              role="tab"
              aria-selected={tab === "open"}
              className={`${styles.tab} ${tab === "open" ? styles.tabActive : ""}`}
              onClick={() => setTab("open")}
            >
              Abierto
              {bio.roster.length > 0 && <span className={styles.tabCount}>{bio.roster.length}</span>}
            </button>
            <button
              role="tab"
              aria-selected={tab === "paqo"}
              className={`${styles.tab} ${tab === "paqo" ? styles.tabActive : ""}`}
              onClick={() => setTab("paqo")}
            >
              Paqo
              {unregisteredHint && <span className={styles.tabSpark} aria-hidden>✦</span>}
            </button>
          </div>
          <div className={styles.headerRight}>
            <span className={`${styles.dot} ${statusDot}`} title={`Conexión: ${bio.status}`} aria-hidden />
            <button
              type="button"
              className={styles.collapseBtn}
              onClick={() => setOpen(false)}
              aria-label="Colapsar el chat"
            >
              ▾
            </button>
          </div>
        </header>

        <div className={styles.body}>
          {tab === "open" ? (
            <OpenChannel
              messages={bio.messages}
              name={bio.name}
              sessionId={bio.sessionId}
              onSetName={bio.setName}
              onSend={bio.sendPublic}
            />
          ) : (
            <PaqoChannel
              biosphereId={biosphereId}
              registered={bio.registered}
              sessionId={bio.sessionId}
              accessToken={bio.accessToken}
              onRegisterClick={() => setShowRegister(true)}
            />
          )}
        </div>
      </section>

      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
    </>
  );
}
