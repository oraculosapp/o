"use client";

import { useEffect } from "react";

/**
 * Cerrojo global de modales. Mientras haya al menos un modal/picker abierto,
 * marca `document.body[data-modal-open="1"]` y avisa a los suscriptores. Lo usa
 * el CookieBanner para ocultarse y no colisionar con diálogos abiertos.
 *
 * Se usa un contador para soportar modales anidados (p.ej. RegisterModal abierto
 * desde dentro de otro flujo).
 */
const EVENT = "phy:modal-lock";
let count = 0;

function apply() {
  if (typeof document === "undefined") return;
  const open = count > 0;
  if (open) document.body.dataset.modalOpen = "1";
  else delete document.body.dataset.modalOpen;
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: open }));
}

export function lockModal(): void {
  count += 1;
  apply();
}

export function unlockModal(): void {
  count = Math.max(0, count - 1);
  apply();
}

export function isModalOpen(): boolean {
  return typeof document !== "undefined" && document.body.dataset.modalOpen === "1";
}

export function subscribeModalLock(cb: (open: boolean) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** Hook: mantiene el cerrojo activo mientras `active` sea true. */
export function useModalLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lockModal();
    return () => unlockModal();
  }, [active]);
}
