"use client";

import { useEffect, useRef, useState } from "react";
import { PaqoWorld, type BiospherePreset } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import { PerfOverlay } from "@/components/dev/PerfOverlay";
import { ChatDock } from "@/components/chat/ChatDock";
import { HintToasts } from "@/components/hints/HintToasts";
import { HudControls } from "@/components/notifications/HudControls";
import type { WorldNetHooks } from "@/lib/realtime";
import styles from "./paqo.module.css";

const BIOSPHERE_ID = "paqo";

export default function PaqoBiosphere() {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<PaqoWorld | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // El JSON completo del preset satisface el subconjunto BiospherePreset.
    const world = new PaqoWorld(el, paqo as unknown as BiospherePreset, () => setReady(true));
    worldRef.current = world;
    world.start();

    return () => {
      worldRef.current = null;
      world.dispose();
    };
  }, []);

  // Getter perezoso del contrato multijugador que el engine adjunta a world.net
  // tras start(). Puede no existir aún: el chat y las pistas degradan con gracia.
  const getWorldNet = (): WorldNetHooks | null => {
    const w = worldRef.current as unknown as { net?: WorldNetHooks } | null;
    return w?.net ?? null;
  };

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      <PerfOverlay />

      {/* HUD social + pistas diegéticas. Se montan siempre: el chat funciona sin
          world.net (sólo pierde presencia) y sin Supabase se oculta con aviso. */}
      <ChatDock biosphereId={BIOSPHERE_ID} getWorldNet={getWorldNet} />
      <HintToasts oracleId={BIOSPHERE_ID} getWorldNet={getWorldNet} />

      {/* Campanita de notificaciones + enlace al perfil (arriba-derecha). */}
      <HudControls />

      {!ready && (
        <div className={styles.loader} role="status" aria-live="polite">
          <div className={styles.rune} aria-hidden />
          <span className={styles.loading}>CARGANDO</span>
        </div>
      )}
    </main>
  );
}
