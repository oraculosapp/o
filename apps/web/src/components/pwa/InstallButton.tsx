"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./install.module.css";

/**
 * Píldora discreta "Instalar app" del design system.
 *
 * - Chrome/Edge/Android: captura `beforeinstallprompt`, muestra la píldora y al
 *   pulsarla lanza el prompt nativo de instalación.
 * - iOS Safari: no hay prompt; mostramos la píldora con instrucciones
 *   "Compartir → Añadir a pantalla de inicio".
 * - Si ya está instalada (display-mode standalone) o no aplica, no se pinta nada.
 *
 * `placement`:
 *   · "inline" (por defecto) — flujo normal (landing, /usuario).
 *   · "hud" — fija arriba-izquierda para el HUD del mundo 3D.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Mode = "hidden" | "prompt" | "ios";

export function InstallButton({ placement = "inline" }: { placement?: "inline" | "hud" }) {
  const [mode, setMode] = useState<Mode>("hidden");
  const [iosHintOpen, setIosHintOpen] = useState(false);
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

  if (mode === "hidden") return null;

  const onClick = async () => {
    if (mode === "ios") {
      setIosHintOpen((v) => !v);
      return;
    }
    const evt = promptRef.current;
    if (!evt) return;
    await evt.prompt();
    const choice = await evt.userChoice;
    if (choice.outcome === "accepted") setMode("hidden");
  };

  const isHud = placement === "hud";
  const wrapClass = isHud ? `${styles.wrap} ${styles.hud}` : styles.wrap;

  return (
    <div className={wrapClass}>
      <button
        type="button"
        className={styles.pill}
        onClick={onClick}
        aria-expanded={mode === "ios" ? iosHintOpen : undefined}
        aria-label={isHud ? "Instalar app" : undefined}
        title={isHud ? "Instalar app" : undefined}
      >
        <DownloadGlyph />
        {/* En el HUD del mundo la píldora es un icono discreto (sin texto) para no
            competir con el resto de controles; en la landing/perfil, con etiqueta. */}
        {!isHud && <span>Instalar app</span>}
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
