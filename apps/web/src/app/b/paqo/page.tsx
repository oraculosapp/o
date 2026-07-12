"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaqoWorld, type BiospherePreset, type AvatarConfig } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import { PerfOverlay } from "@/components/dev/PerfOverlay";
import { ChatDock } from "@/components/chat/ChatDock";
import { HintToasts } from "@/components/hints/HintToasts";
import { HudControls } from "@/components/notifications/HudControls";
import { MuteButton } from "@/components/audio/MuteButton";
import { InstallButton } from "@/components/pwa/InstallButton";
import { AvatarPicker } from "@/components/avatar-picker/AvatarPicker";
import {
  getStoredAvatar,
  saveAvatarToProfile,
  storeAvatar,
  worldConfigFromSelection,
  type AvatarSelection,
} from "@/lib/avatar-store";
import type { WorldNetHooks } from "@/lib/realtime";
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

  // Getter perezoso del contrato multijugador que el engine adjunta a world.net
  // tras start(). Puede no existir aún: el chat y las pistas degradan con gracia.
  const getWorldNet = (): WorldNetHooks | null => {
    const w = worldRef.current as unknown as { net?: WorldNetHooks } | null;
    return w?.net ?? null;
  };

  const onApplyAvatar = useCallback((sel: AvatarSelection, available: boolean) => {
    storeAvatar(sel);
    void saveAvatarToProfile(sel);
    setAvatarSel(sel);
    setPickerOpen(false);
    // Aplica en caliente (tinte inmediato; arquetipo cuando cargue el GLB).
    worldRef.current?.setAvatar(worldConfigFromSelection(sel));
    setToast(
      available
        ? "Tu arquetipo te acompaña ✦"
        : "Este arquetipo aún duerme — viajas con tu esencia y su color hasta que despierte.",
    );
  }, []);

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      <PerfOverlay />

      {/* HUD social + pistas diegéticas. Se montan siempre: el chat funciona sin
          world.net (sólo pierde presencia) y sin Supabase se oculta con aviso. */}
      <ChatDock biosphereId={BIOSPHERE_ID} getWorldNet={getWorldNet} />
      <HintToasts oracleId={BIOSPHERE_ID} getWorldNet={getWorldNet} />

      {/* Campanita + perfil + “Cambiar avatar” (arriba-derecha). */}
      <HudControls onChangeAvatar={() => setPickerOpen(true)} />

      {/* Botón mute del soundscape (arriba-derecha, a la izq. del clúster). */}
      <MuteButton />

      {/* Píldora "Instalar app" (arriba-izquierda); se autooculta si no aplica. */}
      <InstallButton placement="hud" />

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
