"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PaqoWorld, BiospherePreset, AvatarConfig } from "@phygitalia/engine";
import { ChatDock } from "@/components/chat/ChatDock";
import { ChatMenuButton } from "@/components/chat/ChatMenuButton";
import { HintToasts } from "@/components/hints/HintToasts";
import { HudControls } from "@/components/notifications/HudControls";
import { MuteButton } from "@/components/audio/MuteButton";
import { InstallButton } from "@/components/pwa/InstallButton";
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
 * EL MOTOR VIAJA APARTE (ciclo 6, presupuesto de bundle de la RAÍZ).
 *
 * three + el engine + sus loaders + postprocessing eran el 92% del First Load JS
 * de "/" (~266 kB gz). Lo ÚNICO que ataba ese chunk al primer load era el `import`
 * de valor de `PaqoWorld` y el del preset: los `import type` se borran al compilar,
 * así que arriba sólo quedan tipos y el motor entra por `await import()` DENTRO del
 * efecto de montaje (ver más abajo). Resultado: el HTML, el CSS y el HUD (chat,
 * menú, loader) llegan y pintan sin esperar al megabyte del mundo, que se pide en
 * paralelo justo después de hidratar.
 *
 * Regla para quien toque este archivo: cualquier símbolo de `@phygitalia/engine`
 * que se necesite en tiempo de EJECUCIÓN debe pedirse dentro de ese `await import`.
 * Si vuelve a aparecer arriba un `import` de valor (sin `type`), el chunk entero
 * regresa al primer load y el ahorro se pierde en silencio.
 */

/**
 * CARGA BAJO DEMANDA (ciclo 3, presupuesto de bundle de la RAÍZ).
 *
 * Estos tres NO son necesarios para el primer render del mundo y, además, cada uno
 * tiene una CONDICIÓN DE APARICIÓN clara, así que su chunk sólo viaja cuando toca
 * (no es un `dynamic` decorativo: el gate está aquí, en el montaje):
 *
 *   · AvatarPicker  — apertura EXPLÍCITA (botón "Cambiar avatar"). Se monta la
 *     primera vez que `pickerOpen` pasa a true (ver `pickerEverOpened`) y ya se
 *     queda montado, así que la segunda apertura es instantánea. Arrastra consigo
 *     el visor 3D del preview (AvatarLivePreview → nube-live-scene), que era el
 *     sospechoso gordo: three/engine los comparte con el mundo, pero el visor y su
 *     CSS salen del primer load. Sin `loading`: mientras llega el chunk no se pinta
 *     NADA (micro-retardo), nunca un overlay a medias que parpadee.
 *   · PerfOverlay   — sólo existe en desarrollo o con `?dev=1`; el mismo gate que
 *     ya aplicaba internamente, ahora también decide si se DESCARGA.
 *   · MobileControls— sólo en punteros gruesos; en escritorio jamás se pide.
 *
 * `ssr:false` en los tres: ninguno aporta markup al HTML del servidor (el picker
 * nace cerrado, el overlay oculto y los mandos vacíos en escritorio), así que no
 * hay contenido que se pierda ni riesgo de mismatch de hidratación.
 */
const AvatarPicker = dynamic(
  () => import("@/components/avatar-picker/AvatarPicker").then((m) => m.AvatarPicker),
  { ssr: false },
);
const PerfOverlay = dynamic(
  () => import("@/components/dev/PerfOverlay").then((m) => m.PerfOverlay),
  { ssr: false },
);
const MobileControls = dynamic(
  () => import("@/components/notifications/MobileControls").then((m) => m.MobileControls),
  { ssr: false },
);

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

/**
 * RAÍZ del sitio (o.oraculos.app): entra DIRECTO al mundo, sin selector ni
 * splash ni /b/paqo. El biosphereId sigue siendo "paqo" (constante interna); sólo
 * cambia la URL: el mundo vive ahora en la raíz. La ruta antigua /b/paqo redirige
 * aquí por compatibilidad con enlaces y bookmarks viejos.
 */
export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<PaqoWorld | null>(null);
  const [ready, setReady] = useState(false);

  const [avatarSel, setAvatarSel] = useState<AvatarSelection | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * ¿Se abrió YA el selector alguna vez? Es el disparador de la carga bajo demanda:
   * hasta la primera apertura el chunk del picker (con su visor 3D) no se pide.
   * Una vez montado se queda, para que abrir/cerrar de nuevo no cueste nada.
   */
  const [pickerEverOpened, setPickerEverOpened] = useState(false);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Puntero grueso → mandos táctiles (mismo criterio que usa MobileControls dentro). */
  const [isTouch, setIsTouch] = useState(false);
  /** Desarrollo o `?dev=1` → overlay de rendimiento (mismo criterio que PerfOverlay). */
  const [devOverlay, setDevOverlay] = useState(false);

  /** Abre el selector Y, la primera vez, dispara la descarga de su chunk. */
  const openPicker = useCallback(() => {
    setPickerEverOpened(true);
    setPickerOpen(true);
  }, []);

  /** AvatarConfig para el mundo: el GLB "nube" + el color del viajero. */
  const buildAvatarConfig = useCallback((sel: AvatarSelection): AvatarConfig => ({
    ...worldConfigFromSelection(sel),
  }), []);

  /**
   * MONTAJE DEL MUNDO. El efecto es SÍNCRONO por fuera (React nunca recibe una
   * promesa) pero el motor entra por `await import()`, así que entre el montaje y
   * el `new PaqoWorld` hay una ventana en la que el componente puede morir
   * (navegación rápida, doble montaje de StrictMode, recarga en caliente).
   * De ahí el patrón `cancelled`:
   *
   *   · lo primero tras el `await` es comprobarlo: si el componente ya murió NO se
   *     instancia nada — no hay WebGL huérfano, ni bucle rAF, ni el global
   *     `__PAQO__` apuntando a un mundo fantasma;
   *   · si SÍ llegó a instanciarse, el cleanup lo encuentra por `worldRef` y hace
   *     el dispose de siempre (por eso el cleanup lee la ref, no una variable
   *     local: cuando se ejecuta puede que el `world` aún no exista);
   *   · el callback de `ready` también lo mira, para no llamar a `setReady` sobre
   *     un componente desmontado.
   *
   * Lo que NO cambia: el loader "CARGANDO" depende sólo de `ready`, así que ahora
   * cubre además la descarga del chunk (que es justo lo que quieres que cubra), y
   * `getWorld`/`getWorldNet` siguen leyendo `worldRef` con optional chaining, así
   * que el HUD degrada con gracia durante esos milisegundos igual que degradaba
   * antes mientras el engine aún no publicaba `world.net`.
   */
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // Identidad ya sembrada por seedIdentity() (module scope). El fallback
    // cubre modo privado (localStorage puede fallar): nunca se entra sin color.
    const sel = getStoredAvatar() ?? defaultSelection();
    setAvatarSel(sel);

    const avatarConfig: AvatarConfig = buildAvatarConfig(sel);

    let cancelled = false;

    void (async () => {
      // Motor y preset viajan juntos y EN PARALELO: el preset es diminuto (~2 kB)
      // pero es el par natural del motor, y pedirlos a la vez evita encadenar dos
      // esperas de red.
      const [{ PaqoWorld }, preset] = await Promise.all([
        import("@phygitalia/engine"),
        import("@phygitalia/content/biospheres/paqo.json"),
      ]);
      if (cancelled) return;

      // El JSON completo del preset satisface el subconjunto BiospherePreset.
      const world = new PaqoWorld(
        el,
        preset.default as unknown as BiospherePreset,
        () => {
          if (!cancelled) setReady(true);
        },
        avatarConfig,
      );
      worldRef.current = world;
      world.start();

      // Click/tap sobre TU PROPIO avatar → menú de emotes (FASE 2).
      world.onAvatarClick(() => setEmoteOpen(true));
    })().catch((err) => {
      // Chunk que no llega (red caída, despliegue nuevo con hashes rotados): el
      // mundo no arranca y el loader se queda puesto, que es la degradación
      // honesta. Se registra para no tragarse el fallo en silencio.
      console.error("[paqo] no se pudo cargar el motor", err);
    });

    return () => {
      cancelled = true;
      const world = worldRef.current;
      if (!world) return; // el chunk aún no había llegado: no hay nada que soltar
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

  // Gate de los MANDOS TÁCTILES: replica el `(pointer: coarse)` que MobileControls
  // ya evaluaba por dentro, pero un nivel más arriba, para que en escritorio su
  // chunk ni se descargue. Reacciona al "change" igual que el componente (híbridos).
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(pointer: coarse)");
    const apply = () => setIsTouch(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Gate del OVERLAY DE RENDIMIENTO: mismo criterio que PerfOverlay usa por dentro
  // (desarrollo o `?dev=1`). En producción, sin la query, no se pide su chunk.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      setDevOverlay(true);
      return;
    }
    setDevOverlay(new URLSearchParams(window.location.search).get("dev") === "1");
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
  //
  // MEMOIZADOS (deps vacías): ambos getters sólo leen `worldRef`, así que su
  // identidad puede ser estable de por vida. Sin `useCallback` nacían nuevos en
  // CADA render de Home y bajaban como props a ChatDock, donde son dependencia de
  // efectos (`applyChrome` y el de limpieza del chrome): cada render reejecutaba
  // sus cleanups → dos `setViewportInset` (reflow del viewport 3D) por render.
  const getWorldNet = useCallback((): WorldNetHooks | null => {
    const w = worldRef.current as unknown as { net?: WorldNetHooks } | null;
    return w?.net ?? null;
  }, []);

  // Getter perezoso del MUNDO para los hooks de UI (setViewportInset /
  // setInputEnabled / input.*). El engine (equipo paralelo) los adjunta a
  // PaqoWorld; el HUD los consume con optional-chaining, así que degradan con
  // gracia mientras aún no existan.
  const getWorld = useCallback(
    (): WorldUiHooks | null => (worldRef.current as unknown as WorldUiHooks | null) ?? null,
    []
  );

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
      {devOverlay && <PerfOverlay />}

      {/* HUD social. Se monta siempre: el chat funciona sin world.net (sólo
          pierde presencia) y sin Supabase se oculta con aviso. */}
      <ChatDock biosphereId={BIOSPHERE_ID} getWorldNet={getWorldNet} getWorld={getWorld} />
      {/* Los LLAMADOS DE PAQO: pistas susurradas por señal de zona (far/mid/near)
          y ceremonia visual al ENCONTRARLO (found). Degrada con gracia si el
          engine aún no publicó world.net (reintenta y se calla). */}
      <HintToasts oracleId={BIOSPHERE_ID} getWorldNet={getWorldNet} />

      {/* Botones táctiles de saltar/agarrar (sólo en dispositivos touch). El gate
          vive arriba (isTouch) para que en escritorio ni siquiera se descarguen. */}
      {isTouch && <MobileControls getWorld={getWorld} />}

      {/* MENÚ superior-IZQUIERDA: UN SOLO contenedor flex con los 7 controles como
          HERMANOS, en este ORDEN exacto izq→der (la alineación y el wrap a 2 filas
          parejas en móvil salen automáticos del flex):
            (1) editar avatar   ┐ HudControls devuelve estos tres como
            (2) perfil/cuenta   ├ hermanos de fragmento (avatar, cuenta, campana)
            (3) notificaciones  ┘
            (4) ánimo y clima   — MoodPanel
            (5) sonido          — MuteButton
            (6) chat            — ChatMenuButton
            (7) comenzar juego  — GameMenuButton
          Cada control ya sólo aporta su botón (tamaño/forma/glass); su antiguo
          position:fixed + left se retiró. Los popovers (cuenta/campana/ánimo)
          siguen anclados a SU botón (position:absolute sobre su wrapper relativo). */}
      <nav className={styles.topMenu} aria-label="Menú">
        <HudControls
          onChangeAvatar={openPicker}
          avatarThumbUrl={avatarSel ? thumbUrl() : null}
          avatarTint={avatarSel?.color ?? null}
        />
        <MoodPanel getWorld={getWorld} />
        <MuteButton />
        {/* Botón de CHAT: alterna la apertura del ChatDock por evento "phy:toggle-chat". */}
        <ChatMenuButton />
        {/* Botón COMENZAR/DETENER juego: habilitado sólo dentro del claro de Paqo. */}
        <GameMenuButton getWorld={getWorld} />
      </nav>

      {/* HUD del mini-juego (equipo Juego): SÓLO el marcador (running) y el banner de
          resultados, centrados arriba con margen bajo el menú. */}
      <GameHud getWorld={getWorld} />

      {/* Instalar PWA: ya NO es botón del menú → notificación/toast diferida (~20s),
          descartable, recordando el descarte 7 días. Se autooculta si no aplica. */}
      <InstallButton placement="hud" />

      {/* Sólo existe en el árbol desde la PRIMERA apertura (carga bajo demanda). El
          foco no se pierde: el picker monta ya con open=true, así que su useFocusTrap
          corre en el montaje, recuerda el botón "Cambiar avatar" como elemento previo
          y se lo devuelve al cerrar, exactamente igual que antes. */}
      {pickerEverOpened && (
        <AvatarPicker
          open={pickerOpen}
          initial={avatarSel}
          onClose={() => setPickerOpen(false)}
          onApply={onApplyAvatar}
        />
      )}

      {/* Menú de emotes: se abre al clicar/tocar TU avatar (onAvatarClick) o con la
          tecla global "B" (bailar). */}
      <EmoteMenu
        open={emoteOpen}
        onOpen={() => setEmoteOpen(true)}
        onClose={() => setEmoteOpen(false)}
        onPick={onPickEmote}
      />

      {/* Región viva PERSISTENTE del toast del selector (WCAG 4.1.3): el nodo
          `role="status"` no se monta y desmonta con el mensaje —varios lectores de
          pantalla no anuncian una live-region que nace ya con su texto dentro—, sino
          que vive siempre y sólo cambia su contenido. Mismo patrón que HintToasts y
          pwa/UpdateSentinel. Vacío no pinta nada: `.avatarToast` sólo se aplica
          cuando hay mensaje. */}
      <div role="status" aria-live="polite">
        {toast && <div className={styles.avatarToast}>{toast}</div>}
      </div>

      {!ready && (
        <div className={styles.loader} role="status" aria-live="polite">
          <div className={styles.rune} aria-hidden />
          <span className={styles.loading}>CARGANDO</span>
        </div>
      )}
    </main>
  );
}
