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
 * Se monta una vez en el layout raíz. No pinta nada.
 */
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

    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // Silencioso: un SW que no registra nunca debe romper la app.
        console.warn("[pwa] registro de service worker falló:", err);
      });
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
