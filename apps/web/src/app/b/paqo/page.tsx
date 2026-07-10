"use client";

import { useEffect, useRef, useState } from "react";
import { HolaPlaneta, type PlanetPreset } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import styles from "./paqo.module.css";

export default function PaqoBiosphere() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // El JSON completo del preset satisface el subconjunto PlanetPreset.
    const planet = new HolaPlaneta(el, paqo as unknown as PlanetPreset, () => setReady(true));
    planet.start();

    return () => planet.dispose();
  }, []);

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      {!ready && (
        <div className={styles.loader} role="status" aria-live="polite">
          <div className={styles.rune} aria-hidden />
          <span className={styles.loading}>CARGANDO</span>
        </div>
      )}
    </main>
  );
}
