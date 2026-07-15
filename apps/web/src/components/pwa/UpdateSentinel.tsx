"use client";

import { useEffect, useRef, useState } from "react";
import { isNewVersion, parseVersion } from "./update-check";
import styles from "./update-sentinel.module.css";

/**
 * Centinela de versión. Evita que un usuario se quede atascado en una build
 * vieja (pestaña/PWA abierta en memoria desde antes de un deploy) — el fallo que
 * dejó el móvil y la compu de Julio sin verse en multijugador.
 *
 * Lleva su build id EMBEBIDO (inyectado en build por next.config vía
 * NEXT_PUBLIC_BUILD_ID) y lo compara contra el del deploy VIVO que sirve
 * `/api/version`. Comprueba: al montar, cada 5 min, y en `visibilitychange`
 * (volver a la pestaña — el momento clave en móvil, donde los timers se
 * suspenden en background).
 *
 * Al detectar diferencia:
 *   · Pestaña en BACKGROUND o REGRESO a la pestaña → recarga SILENCIOSA (sin
 *     UI), en cuanto sea seguro.
 *   · Usuario MIRANDO activamente (chequeo periódico) → píldora dorada
 *     "✨ Nueva versión disponible — Actualizar"; al tocarla, recarga.
 *
 * Nunca interrumpe una partida activa de ¡Dale a Paqo!: la recarga silenciosa se
 * pospone mientras `window.__PAQO__.game.snapshot().phase === "running"` (el
 * equipo Juego expone ese global); si no existe, degrada a "no hay partida".
 * La píldora manual, en cambio, siempre respeta la decisión del usuario.
 *
 * Se monta una vez en el layout raíz. No pinta nada salvo la píldora.
 */

const EMBEDDED_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const PENDING_POLL_MS = 20 * 1000; // reintento de recarga pospuesta

/** ¿Hay una partida de ¡Dale a Paqo! en curso? (degrada a `false` si no existe el global). */
function isPaqoGameRunning(): boolean {
  try {
    const w = window as unknown as {
      __PAQO__?: { game?: { snapshot?: () => { phase?: string } } };
    };
    return w.__PAQO__?.game?.snapshot?.().phase === "running";
  } catch {
    return false;
  }
}

export function UpdateSentinel() {
  const [showToast, setShowToast] = useState(false);
  const pendingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    /** Recarga silenciosa SOLO cuando es seguro: pestaña visible y sin partida. */
    const silentReloadWhenSafe = () => {
      if (document.visibilityState !== "visible") return; // esperar a volver
      if (isPaqoGameRunning()) return; // no interrumpir la partida
      window.location.reload();
    };

    /** Mientras haya recarga pendiente pero bloqueada, reintentar en bucle lento. */
    const ensurePendingPoll = () => {
      if (pollRef.current != null) return;
      pollRef.current = setInterval(() => {
        if (!pendingRef.current) {
          if (pollRef.current != null) clearInterval(pollRef.current);
          pollRef.current = null;
          return;
        }
        silentReloadWhenSafe();
      }, PENDING_POLL_MS);
    };

    const check = async (trigger: "mount" | "interval" | "visible") => {
      let remote: string | null = null;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        remote = parseVersion(await res.json());
      } catch {
        return; // sin red / respuesta rara → no concluir nada
      }
      if (cancelled) return;
      if (!isNewVersion(EMBEDDED_BUILD_ID, remote)) return;

      // Hay una versión nueva desplegada.
      pendingRef.current = true;

      const hidden = document.visibilityState !== "visible";
      if (hidden || trigger === "visible") {
        // Background o regreso a la pestaña → recarga silenciosa, sin molestar.
        silentReloadWhenSafe();
        ensurePendingPoll();
      } else {
        // Usuario mirando activamente → ofrecer la píldora (no dar el tirón).
        setShowToast(true);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // Al volver: cerrar una recarga pendiente y re-chequear por si hubo deploy.
      if (pendingRef.current) silentReloadWhenSafe();
      void check("visible");
    };

    void check("mount");
    const interval = setInterval(() => void check("interval"), CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (pollRef.current != null) clearInterval(pollRef.current);
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Región aria-live PERSISTENTE: el contenedor vive siempre en el DOM (aunque no
  // haya píldora) para que el lector de pantalla anuncie la aparición del aviso.
  // Si la región se montara junto con el botón, el cambio de contenido no se
  // anunciaría de forma fiable. El contenedor no ocupa espacio: su único hijo es la
  // píldora position:fixed.
  return (
    <div role="status" aria-live="polite">
      {showToast && (
        <button
          type="button"
          className={styles.toast}
          onClick={() => window.location.reload()}
        >
          <span className={styles.spark} aria-hidden>
            ✨
          </span>
          <span>
            Nueva versión disponible — <span className={styles.action}>Actualizar</span>
          </span>
        </button>
      )}
    </div>
  );
}
