"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./install.module.css";

/**
 * Invitación a instalar la PWA del design system.
 *
 * - Chrome/Edge/Android: captura `beforeinstallprompt` y al pulsar lanza el prompt
 *   nativo de instalación.
 * - iOS Safari: no hay prompt; se muestran instrucciones "Compartir → Añadir a
 *   pantalla de inicio".
 * - Si ya está instalada (display-mode standalone) o no aplica, no se pinta nada.
 *
 * `placement`:
 *   · "inline" (por defecto) — píldora en el flujo normal (landing, /usuario).
 *   · "hud" — NOTIFICACIÓN (toast) para el mundo 3D: ya NO es un botón permanente
 *     del menú. Aparece ~20 s tras la primera visita instalable, con el glass de la
 *     casa (estilo UpdateSentinel), y es descartable (×). El descarte se recuerda en
 *     localStorage `phy:install-dismissed` durante 7 días.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Mode = "hidden" | "prompt" | "ios";

/** Retardo antes de asomar el toast en el HUD (primera visita instalable). */
const INSTALL_TOAST_DELAY_MS = 20_000;
/** Clave y ventana del descarte recordado (7 días). */
const DISMISS_KEY = "phy:install-dismissed";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** ¿El usuario descartó el toast hace menos de 7 días? (degrada a false sin storage). */
function isRecentlyDismissed(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const t = Number(raw);
    return Number.isFinite(t) && Date.now() - t < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* almacenamiento no disponible → sólo se pierde la persistencia del descarte */
  }
}

export function InstallButton({ placement = "inline" }: { placement?: "inline" | "hud" }) {
  const [mode, setMode] = useState<Mode>("hidden");
  const [iosHintOpen, setIosHintOpen] = useState(false);
  // Sólo para el HUD (toast): visibilidad diferida ~20 s tras hacerse instalable.
  const [visible, setVisible] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Ya instalada → nunca mostrar.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari expone navigator.standalone.
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const ua = navigator.userAgent;
    const isIOS =
      /iphone|ipad|ipod/i.test(ua) ||
      // iPadOS se disfraza de Mac: detectar por touch.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);

    if (isIOS && isSafari) {
      setMode("ios");
      return;
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // evita el mini-infobar por defecto; controlamos la UX.
      promptRef.current = e as BeforeInstallPromptEvent;
      setMode("prompt");
    };
    const onInstalled = () => {
      promptRef.current = null;
      setMode("hidden");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // HUD: asoma el toast ~20 s después de hacerse instalable, salvo descarte reciente.
  useEffect(() => {
    if (placement !== "hud" || mode === "hidden") return;
    if (isRecentlyDismissed()) return;
    const t = setTimeout(() => setVisible(true), INSTALL_TOAST_DELAY_MS);
    return () => clearTimeout(t);
  }, [placement, mode]);

  if (mode === "hidden") return null;

  const doInstall = async () => {
    if (mode === "ios") {
      setIosHintOpen((v) => !v);
      return;
    }
    const evt = promptRef.current;
    if (!evt) return;
    await evt.prompt();
    const choice = await evt.userChoice;
    if (choice.outcome === "accepted") {
      setMode("hidden");
      setVisible(false);
    }
  };

  // --- HUD: notificación/toast (no botón permanente del menú) ------------------
  if (placement === "hud") {
    if (!visible) return null;
    const dismiss = () => {
      markDismissed();
      setVisible(false);
    };
    return (
      <div className={styles.toast} role="status" aria-live="polite">
        <button
          type="button"
          className={styles.toastAction}
          onClick={doInstall}
          aria-expanded={mode === "ios" ? iosHintOpen : undefined}
        >
          <DownloadGlyph />
          <span>Instalar app</span>
        </button>

        {mode === "ios" && iosHintOpen && (
          <p className={styles.toastIosText}>
            Toca <b>Compartir</b>
            <ShareGlyph /> y luego <b>Añadir a pantalla de inicio</b>.
          </p>
        )}

        <button
          type="button"
          className={styles.toastDismiss}
          onClick={dismiss}
          aria-label="Descartar"
          title="Descartar"
        >
          ×
        </button>
      </div>
    );
  }

  // --- Inline: píldora clásica (landing / perfil) ------------------------------
  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.pill} onClick={doInstall} aria-expanded={mode === "ios" ? iosHintOpen : undefined}>
        <DownloadGlyph />
        <span>Instalar app</span>
      </button>

      {mode === "ios" && iosHintOpen && (
        <div className={styles.iosHint} role="dialog" aria-label="Cómo instalar en iPhone">
          <p className={styles.iosText}>
            Toca <b>Compartir</b>
            <ShareGlyph /> y luego <b>Añadir a pantalla de inicio</b>.
          </p>
        </div>
      )}
    </div>
  );
}

function DownloadGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v11m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ShareGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden style={{ verticalAlign: "-2px", margin: "0 2px" }}>
      <path d="M12 3v12M12 3 8 7m4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 12H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
