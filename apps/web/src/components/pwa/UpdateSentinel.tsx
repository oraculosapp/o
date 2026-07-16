"use client";

import { useEffect, useState } from "react";
import { isNewVersion, parseVersion } from "./update-check";
import { forceReload, isReloadArmed, requestReload } from "./reload-coordinator";
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
 * suspenden en background). El beacon de versión es la señal PRINCIPAL en
 * background; el flujo del Service Worker es la red de seguridad para cuando lo
 * que cambia es el propio SW.
 *
 * Al detectar diferencia:
 *   · Pestaña en BACKGROUND o REGRESO a la pestaña → recarga SILENCIOSA (sin UI),
 *     en cuanto sea seguro.
 *   · Usuario MIRANDO activamente (chequeo periódico) → píldora dorada
 *     "✨ Nueva versión disponible — Actualizar"; al tocarla, recarga.
 *
 * Ambas recargas pasan por el COORDINADOR común (`reload-coordinator`), que
 * comparte el guardarraíl de partida y un flag anti-bucle con el flujo del SW:
 * si el SW ya va a recargar, el centinela no duplica; si el centinela ya recargó,
 * el SW no vuelve a hacerlo. La recarga silenciosa se pospone mientras haya una
 * partida de ¡Dale a Paqo! en curso; la píldora manual, en cambio, siempre
 * respeta la decisión del usuario (recarga aunque haya partida).
 *
 * Se monta una vez en el layout raíz. No pinta nada salvo la píldora.
 */

const EMBEDDED_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export function UpdateSentinel() {
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

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

      // Hay una versión nueva desplegada. Si el flujo del SW ya armó la recarga,
      // no hacemos nada (evita doble camino / doble píldora).
      if (isReloadArmed()) return;

      const hidden = document.visibilityState !== "visible";
      if (hidden || trigger === "visible") {
        // Background o regreso a la pestaña → recarga silenciosa (el coordinador
        // la aplaza si hay partida y la dispara en cuanto sea seguro).
        requestReload();
      } else {
        // Usuario mirando activamente → ofrecer la píldora (no dar el tirón).
        setShowToast(true);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      // Al volver: re-chequear por si hubo deploy. Una recarga silenciosa ya
      // pendiente la retoma el propio coordinador (tiene su listener de
      // visibilidad); aquí solo detectamos deploys nuevos.
      void check("visible");
    };

    void check("mount");
    const interval = setInterval(() => void check("interval"), CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
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
        <button type="button" className={styles.toast} onClick={() => forceReload()}>
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
