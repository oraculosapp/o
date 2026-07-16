"use client";

import { useEffect } from "react";
import { requestReload } from "./reload-coordinator";

/**
 * Registra el Service Worker (/sw.js) SOLO en producción, tras `load`, para no
 * competir con la carga crítica de la landing 3D.
 *
 * En desarrollo hace lo contrario: elimina cualquier SW previo. Un SW cacheando
 * respuestas rompe el HMR de Next, así que en `next dev` nos aseguramos de que
 * no quede ninguno registrado de una visita anterior.
 *
 * === Auto-actualización A PRUEBA DE BALAS ===
 * El bug que dejó el móvil de Julio clavado en una build vieja: el SW viejo y el
 * JS en memoria del PWA no se refrescan solos. Aquí lo cerramos por completo:
 *
 *   1. `updateViaCache: "none"` → el navegador SIEMPRE revalida `/sw.js` contra
 *      la red al comprobar actualizaciones. Sin esto, si `/sw.js` se sirviera de
 *      caché HTTP, un SW nuevo NUNCA se descubriría (la causa raíz más pérfida).
 *   2. `updatefound` → cuando el worker entrante llega a `installed` y YA había
 *      un `controller` (o sea: es una ACTUALIZACIÓN, no la primera instalación),
 *      le mandamos `SKIP_WAITING` para que active de inmediato sin esperar a que
 *      se cierren todas las pestañas.
 *   3. `controllerchange` → cuando el SW nuevo toma el control, recargamos UNA
 *      vez (vía el coordinador común, que respeta la partida en curso y evita
 *      bucles). La primera adopción del controller (instalación inicial, sin
 *      controller previo) NO recarga: no hay código viejo que reemplazar.
 *   4. `reg.update()` periódico (30 min) + en `visibilitychange` → acelera el
 *      descubrimiento de despliegues.
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

    // ¿Estábamos ya controlados por un SW al arrancar? Si sí, cualquier cambio de
    // controller es una ACTUALIZACIÓN → recargar. Si no, la primera adopción del
    // controller es la instalación inicial → NO recargar. Mutable: tras la
    // primera adopción quedamos "controlados" y los cambios siguientes ya sí son
    // actualizaciones aunque la pestaña siga abierta entre deploys.
    let controlled = !!navigator.serviceWorker.controller;

    const onControllerChange = () => {
      const wasControlled = controlled;
      controlled = true;
      if (!wasControlled) return; // primera adopción (instalación inicial): no recargar
      // SW nuevo al mando → recargar en cuanto sea seguro (coordinado con el
      // centinela de versión: el flag común impide la doble recarga).
      requestReload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const watchInstalling = (reg: ServiceWorkerRegistration) => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // Solo forzamos el salto cuando es una ACTUALIZACIÓN (había controller);
        // en la primera instalación dejamos que el ciclo normal siga su curso.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          installing.postMessage({ type: "SKIP_WAITING" });
        }
      });
    };

    const pokeUpdate = () => {
      // Silencioso: un update() fallido nunca debe romper la app.
      registration?.update().catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") pokeUpdate();
    };

    const onLoad = () => {
      navigator.serviceWorker
        // updateViaCache:"none" — clave: revalidar siempre /sw.js contra la red.
        .register("/sw.js", { updateViaCache: "none" })
        .then((reg) => {
          registration = reg;
          // Si ya hay un worker entrante en vuelo, engánchalo también.
          if (reg.installing) watchInstalling(reg);
          reg.addEventListener("updatefound", () => watchInstalling(reg));
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
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (interval != null) clearInterval(interval);
    };
  }, []);

  return null;
}
