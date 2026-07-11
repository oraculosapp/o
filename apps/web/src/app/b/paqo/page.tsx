"use client";

import { useEffect, useRef, useState } from "react";
import { PaqoWorld, type BiospherePreset } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import { PerfOverlay } from "@/components/dev/PerfOverlay";
import styles from "./paqo.module.css";

export default function PaqoBiosphere() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // El JSON completo del preset satisface el subconjunto BiospherePreset.
    const world = new PaqoWorld(el, paqo as unknown as BiospherePreset, () => setReady(true));
    world.start();

    return () => world.dispose();
  }, []);

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      <PerfOverlay />
      {!ready && (
        <div className={styles.loader} role="status" aria-live="polite">
          <div className={styles.rune} aria-hidden />
          <span className={styles.loading}>CARGANDO</span>
        </div>
      )}
    </main>
  );
}
