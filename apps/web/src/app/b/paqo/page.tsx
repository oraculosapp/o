"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaqoWorld, type BiospherePreset, type AvatarConfig } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import { PerfOverlay } from "@/components/dev/PerfOverlay";
import { ChatDock } from "@/components/chat/ChatDock";
import { HintToasts } from "@/components/hints/HintToasts";
import { HudControls } from "@/components/notifications/HudControls";
import { MobileControls } from "@/components/notifications/MobileControls";
import { MuteButton } from "@/components/audio/MuteButton";
import { InstallButton } from "@/components/pwa/InstallButton";
import { AvatarPicker } from "@/components/avatar-picker/AvatarPicker";
import { MoodPanel } from "@/components/mood/MoodPanel";
import { GameHud } from "@/components/game/GameHud";
import { thumbUrl } from "@/lib/avatars";
import {
  getStoredAvatar,
  saveAvatarToProfile,
  storeAvatar,
  worldConfigFromSelection,
  type AvatarSelection,
} from "@/lib/avatar-store";
import type { WorldNetHooks } from "@/lib/realtime";
import type { WorldUiHooks } from "@/lib/world-ui";
import styles from "./paqo.module.css";

const BIOSPHERE_ID = "paqo";

export default function PaqoBiosphere() {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<PaqoWorld | null>(null);
  const [ready, setReady] = useState(false);

  const [avatarSel, setAvatarSel] = useState<AvatarSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // Avatar elegido (o ninguno la primera vez → abre el selector).
    const sel = getStoredAvatar();
    setAvatarSel(sel);
    if (!sel) setPickerOpen(true);

    const avatarConfig: AvatarConfig | undefined = sel
      ? { ...worldConfigFromSelection(sel) }
      : undefined;

    // El JSON completo del preset satisface el subconjunto BiospherePreset.
    const world = new PaqoWorld(
      el,
      paqo as unknown as BiospherePreset,
      () => setReady(true),
      avatarConfig,
    );
    worldRef.current = world;
    world.start();

    return () => {
      worldRef.current = null;
      world.dispose();
    };
  }, []);

  // Auto-oculta el toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // Expone la preferencia de MOVIMIENTO REDUCIDO al engine (que congela
  // cámara/parallax/swarm). Contrato para el agente de engine:
  //   · <html data-reduced-motion="1|0">
  //   · localStorage["phy:reduced-motion"] = "1|0"
  // El engine debe leer cualquiera de los dos al iniciar y reaccionar al evento
  // "change" del media query si quiere aplicarlo en caliente.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      const on = mq.matches;
      document.documentElement.dataset.reducedMotion = on ? "1" : "0";
      try {
        localStorage.setItem("phy:reduced-motion", on ? "1" : "0");
      } catch {
        /* noop */
      }
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Getter perezoso del contrato multijugador que el engine adjunta a world.net
  // tras start(). Puede no existir aún: el chat y las pistas degradan con gracia.
  const getWorldNet = (): WorldNetHooks | null => {
    const w = worldRef.current as unknown as { net?: WorldNetHooks } | null;
    return w?.net ?? null;
  };

  // Getter perezoso del MUNDO para los hooks de UI (setViewportInset /
  // setInputEnabled / input.*). El engine (equipo paralelo) los adjunta a
  // PaqoWorld; el HUD los consume con optional-chaining, así que degradan con
  // gracia mientras aún no existan.
  const getWorld = (): WorldUiHooks | null =>
    (worldRef.current as unknown as WorldUiHooks | null) ?? null;

  const onApplyAvatar = useCallback((sel: AvatarSelection) => {
    storeAvatar(sel);
    void saveAvatarToProfile(sel);
    setAvatarSel(sel);
    setPickerOpen(false);
    // Aplica en caliente: el arquetipo procedural se encarna al instante (sin red).
    worldRef.current?.setAvatar(worldConfigFromSelection(sel));
    setToast("Tu arquetipo te acompaña ✦");
  }, []);

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      <PerfOverlay />

      {/* HUD social + pistas diegéticas. Se montan siempre: el chat funciona sin
          world.net (sólo pierde presencia) y sin Supabase se oculta con aviso. */}
      <ChatDock biosphereId={BIOSPHERE_ID} getWorldNet={getWorldNet} getWorld={getWorld} />
      <HintToasts oracleId={BIOSPHERE_ID} getWorldNet={getWorldNet} />

      {/* Botones táctiles de saltar/agarrar (sólo en dispositivos touch). */}
      <MobileControls getWorld={getWorld} />

      {/* Clúster superior-IZQUIERDA sobre el juego (NO sobre la columna del chat,
          que ocupa la derecha a toda altura): Instalar · mute · avatar ·
          campanita+cuenta, en fila. */}

      {/* Píldora "Instalar app" (left:16); se autooculta si no aplica. */}
      <InstallButton placement="hud" />

      {/* Botón mute del soundscape (left:68). */}
      <MuteButton />

      {/* Campanita + perfil + “Cambiar avatar” (avatar left:116, cluster left:164).
          El avatar muestra el retrato/tinte actual para no confundirse con Perfil. */}
      <HudControls
        onChangeAvatar={() => setPickerOpen(true)}
        avatarThumbUrl={avatarSel ? thumbUrl(avatarSel.archetype) : null}
        avatarTint={avatarSel?.tint.primary ?? null}
      />

      {/* Panel de mood/clima (equipo Atmos) y HUD del mini-juego (equipo Juego).
          Stubs: montados con el getter perezoso del mundo; aún no pintan nada. */}
      <MoodPanel getWorld={getWorld} />
      <GameHud getWorld={getWorld} />

      <AvatarPicker
        open={pickerOpen}
        initial={avatarSel}
        onClose={() => setPickerOpen(false)}
        onApply={onApplyAvatar}
      />

      {toast && (
        <div className={styles.avatarToast} role="status" aria-live="polite">
          {toast}
        </div>
      )}

      {!ready && (
        <div className={styles.loader} role="status" aria-live="polite">
          <div className={styles.rune} aria-hidden />
          <span className={styles.loading}>CARGANDO</span>
        </div>
      )}
    </main>
  );
}
