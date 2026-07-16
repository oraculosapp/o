"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PaqoWorld, type BiospherePreset, type AvatarConfig } from "@phygitalia/engine";
import paqo from "@phygitalia/content/biospheres/paqo.json";
import { PerfOverlay } from "@/components/dev/PerfOverlay";
import { ChatDock } from "@/components/chat/ChatDock";
import { ChatMenuButton } from "@/components/chat/ChatMenuButton";
// HintToasts (los llamados de Paqo) OCULTOS por ahora — se reactivará más adelante.
// import { HintToasts } from "@/components/hints/HintToasts";
import { HudControls } from "@/components/notifications/HudControls";
import { MobileControls } from "@/components/notifications/MobileControls";
import { MuteButton } from "@/components/audio/MuteButton";
import { InstallButton } from "@/components/pwa/InstallButton";
import { AvatarPicker } from "@/components/avatar-picker/AvatarPicker";
import { EmoteMenu } from "@/components/avatar-picker/EmoteMenu";
import { MoodPanel } from "@/components/mood/MoodPanel";
import { GameHud } from "@/components/game/GameHud";
import { GameMenuButton } from "@/components/game/GameMenuButton";
import { thumbUrl } from "@/lib/avatars";
import { randomName } from "@/lib/names";
import {
  defaultSelection,
  getStoredAvatar,
  saveAvatarToProfile,
  storeAvatar,
  worldConfigFromSelection,
  type AvatarSelection,
} from "@/lib/avatar-store";
import { getStoredName, storeName } from "@/lib/oracle-client";
import type { WorldNetHooks } from "@/lib/realtime";
import type { WorldUiHooks } from "@/lib/world-ui";
import styles from "./paqo.module.css";

const BIOSPHERE_ID = "paqo";

/**
 * Siembra de identidad (S8, entrada sin fricción): al PRIMER ingreso asigna
 * color pastel + nombre aleatorios. Va en module scope (cliente) para correr
 * ANTES de cualquier efecto: los efectos de los HIJOS (ChatDock → useBiosphere,
 * que lee el nombre y el tint para la presencia) corren antes que el efecto de
 * esta página, así que sembrar aquí garantiza que el chat nazca ya con la
 * identidad correcta. Idempotente; ids viejos se normalizan a "nube" al leer.
 */
function seedIdentity(): void {
  if (typeof window === "undefined") return;
  if (!getStoredAvatar()) storeAvatar(defaultSelection());
  if (!getStoredName()) storeName(randomName());
}
seedIdentity();

export default function PaqoBiosphere() {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<PaqoWorld | null>(null);
  const [ready, setReady] = useState(false);

  const [avatarSel, setAvatarSel] = useState<AvatarSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** AvatarConfig para el mundo: el GLB "nube" + el color del viajero. */
  const buildAvatarConfig = useCallback((sel: AvatarSelection): AvatarConfig => ({
    ...worldConfigFromSelection(sel),
  }), []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // Identidad ya sembrada por seedIdentity() (module scope). El fallback
    // cubre modo privado (localStorage puede fallar): nunca se entra sin color.
    const sel = getStoredAvatar() ?? defaultSelection();
    setAvatarSel(sel);

    const avatarConfig: AvatarConfig = buildAvatarConfig(sel);

    // El JSON completo del preset satisface el subconjunto BiospherePreset.
    const world = new PaqoWorld(
      el,
      paqo as unknown as BiospherePreset,
      () => setReady(true),
      avatarConfig,
    );
    worldRef.current = world;
    world.start();

    // Click/tap sobre TU PROPIO avatar → menú de emotes (FASE 2).
    world.onAvatarClick(() => setEmoteOpen(true));

    return () => {
      world.onAvatarClick(null);
      worldRef.current = null;
      world.dispose();
    };
  }, []);

  /** Dispara un emote: lo reproduce el rig local Y se difunde a los remotos. */
  const onPickEmote = useCallback((id: string) => {
    const world = worldRef.current;
    if (!world) return;
    world.controller?.getRig()?.playEmote(id);
    world.net?.emitLocalEmote(id);
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
    // Aplica en caliente: re-tinta el avatar nube (misma malla, nuevo color).
    worldRef.current?.setAvatar(buildAvatarConfig(sel));
    setToast("Tu color te acompaña ✦");
  }, []);

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />
      <PerfOverlay />

      {/* HUD social. Se monta siempre: el chat funciona sin world.net (sólo
          pierde presencia) y sin Supabase se oculta con aviso. */}
      <ChatDock biosphereId={BIOSPHERE_ID} getWorldNet={getWorldNet} getWorld={getWorld} />
      {/* HintToasts (llamados de Paqo) DESMONTADOS — se reactivará más adelante.
          <HintToasts oracleId={BIOSPHERE_ID} getWorldNet={getWorldNet} /> */}

      {/* Botones táctiles de saltar/agarrar (sólo en dispositivos touch). */}
      <MobileControls getWorld={getWorld} />

      {/* MENÚ superior-IZQUIERDA sobre el juego (NO sobre la columna del chat, que
          ocupa la derecha a toda altura). Orden EXACTO izq→der (cada control se ancla
          por su propio CSS al slot indicado):
            (1) editar avatar   — HudControls .avatarSlot (left:16)
            (2) perfil/cuenta   — HudControls .cluster → AccountFab (left:64)
            (3) notificaciones  — HudControls .cluster → Bell (~left:112)
            (4) ánimo y clima   — MoodPanel (left:160)
            (5) sonido          — MuteButton (left:208)
            (6) chat            — ChatMenuButton (left:256)
            (7) comenzar juego  — GameMenuButton (left:304)
          El montaje aquí no fija el orden visual (todos son position:fixed); lo fijan
          los `left` de cada módulo. */}
      <HudControls
        onChangeAvatar={() => setPickerOpen(true)}
        avatarThumbUrl={avatarSel ? thumbUrl() : null}
        avatarTint={avatarSel?.color ?? null}
      />
      <MoodPanel getWorld={getWorld} />
      <MuteButton />
      {/* Botón de CHAT: alterna la apertura del ChatDock por evento "phy:toggle-chat"
          (reemplaza al antiguo launcher flotante). */}
      <ChatMenuButton />
      {/* Botón COMENZAR/DETENER juego: habilitado sólo dentro del claro de Paqo. */}
      <GameMenuButton getWorld={getWorld} />

      {/* HUD del mini-juego (equipo Juego): SÓLO el marcador (running) y el banner de
          resultados, centrados arriba con margen bajo el menú. */}
      <GameHud getWorld={getWorld} />

      {/* Instalar PWA: ya NO es botón del menú → notificación/toast diferida (~20s),
          descartable, recordando el descarte 7 días. Se autooculta si no aplica. */}
      <InstallButton placement="hud" />

      <AvatarPicker
        open={pickerOpen}
        initial={avatarSel}
        onClose={() => setPickerOpen(false)}
        onApply={onApplyAvatar}
      />

      {/* Menú de emotes: se abre al clicar/tocar TU avatar (onAvatarClick) o con la
          tecla global "B" (bailar). */}
      <EmoteMenu
        open={emoteOpen}
        onOpen={() => setEmoteOpen(true)}
        onClose={() => setEmoteOpen(false)}
        onPick={onPickEmote}
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
