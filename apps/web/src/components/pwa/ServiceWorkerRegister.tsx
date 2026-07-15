"use client";

import { useEffect } from "react";

/**
 * Registra el Service Worker (/sw.js) SOLO en producción, tras `load`, para no
 * competir con la carga crítica de la landing 3D.
 *
 * En desarrollo hace lo contrario: elimina cualquier SW previo. Un SW cacheando
 * respuestas rompe el HMR de Next, así que en `next dev` nos aseguramos de que
 * no quede ninguno registrado de una visita anterior.
 *
 * Además, sondea `reg.update()` cada 30 min y al volver a la pestaña
 * (`visibilitychange`): así el navegador descarga a tiempo un `/sw.js` nuevo,
 * lo que acelera el descubrimiento de despliegues junto con el UpdateSentinel.
 *
 * Se monta una vez en el layout raíz. No pinta nada.
 */
const SW_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      // Dev: barrer SW viejos para que no interfieran con HMR.
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => void reg.unregister());
      });
      return;
    }

    let registration: ServiceWorkerRegistration | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const pokeUpdate = () => {
      // Silencioso: un update() fallido nunca debe romper la app.
      registration?.update().catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") pokeUpdate();
    };

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          registration = reg;
          // Sondeo periódico + al volver a la pestaña.
          interval = setInterval(pokeUpdate, SW_UPDATE_INTERVAL_MS);
          document.addEventListener("visibilitychange", onVisibility);
        })
        .catch((err) => {
          // Silencioso: un SW que no registra nunca debe romper la app.
          console.warn("[pwa] registro de service worker falló:", err);
        });
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      window.removeEventListener("load", onLoad);
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval != null) clearInterval(interval);
    };
  }, []);

  return null;
}
