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
}

export function MessageRow({ displayName, content, isOracle, mine, tint }: MessageRowProps) {
  return (
    <li className={`${styles.row} ${isOracle ? styles.rowOracle : ""} ${mine ? styles.rowMine : ""}`}>
      <div className={styles.avatarCol}>
        {isOracle ? <OracleAvatar /> : <TravelerAvatar name={displayName} tint={tint} />}
      </div>
      <div className={styles.bubbleCol}>
        <span className={`${styles.author} ${isOracle ? styles.authorOracle : ""}`}>
          {displayName}
          {isOracle && <span className={styles.oracleBadge}>oráculo</span>}
        </span>
        <p className={styles.bubble}>{content}</p>
      </div>
    </li>
  );
}
