"use client";

import { useState } from "react";
import styles from "./chat.module.css";

/** Retrato de Paqo si existe en /assets; si falla, círculo dorado con "P". */
function OracleAvatar() {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className={styles.oracleGlyph} aria-hidden>
        P
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/assets/oracles/paqo.jpg"
      alt=""
      className={styles.oraclePortrait}
      onError={() => setBroken(true)}
      aria-hidden
    />
  );
}

/** Avatar de un viajero: inicial sobre un disco con su tint. */
function TravelerAvatar({ name, tint }: { name: string; tint?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={styles.travelerGlyph}
      style={tint ? { background: tint, color: "#12141f" } : undefined}
      aria-hidden
    >
      {initial}
    </span>
  );
}

export interface MessageRowProps {
  displayName: string;
  content: string;
  isOracle: boolean;
  mine?: boolean;
  tint?: string;
  /** ISO 8601 del mensaje; se muestra como hora discreta (HH:MM). */
  createdAt?: string;
}

/** Hora discreta local HH:MM; tolerante a fechas inválidas (no rompe el render). */
function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageRow({ displayName, content, isOracle, mine, tint, createdAt }: MessageRowProps) {
  const time = formatTime(createdAt);
  return (
    <li className={`${styles.row} ${isOracle ? styles.rowOracle : ""} ${mine ? styles.rowMine : ""}`}>
      <div className={styles.avatarCol}>
        {isOracle ? <OracleAvatar /> : <TravelerAvatar name={displayName} tint={tint} />}
      </div>
      <div className={styles.bubbleCol}>
        <span className={`${styles.author} ${isOracle ? styles.authorOracle : ""}`}>
          {isOracle && <span className={styles.oracleSpark} aria-hidden>✦</span>}
          {displayName}
          {isOracle && <span className={styles.oracleBadge}>Paqo</span>}
          {time && (
            <time className={styles.time} dateTime={createdAt}>
              {time}
            </time>
          )}
        </span>
        <p className={styles.bubble}>{content}</p>
      </div>
    </li>
  );
}
