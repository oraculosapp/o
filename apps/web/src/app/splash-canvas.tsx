"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

/** Detecta WebGL sin instanciar el motor completo. */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl"))
    );
  } catch {
    return false;
  }
}

/**
 * Monta el diorama three.js client-only sobre la nebulosa CSS. Carga el módulo
 * de escena de forma diferida (import dinámico) para que three.js NO entre en el
 * bundle inicial: el logo y el botón (SSR) pintan antes de tocar la GPU.
 *
 * Sin WebGL → no monta nada: queda la nebulosa CSS + logo + botón (el fallback
 * estático es la propia landing).
 */
export default function SplashCanvas() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !hasWebGL()) return;

    let scene: { start(): void; dispose(): void } | null = null;
    let cancelled = false;

    // Import diferido: el chunk de three.js se descarga tras el primer pintado.
    import("./splash-scene")
      .then(({ SplashScene }) => {
        if (cancelled || !mountRef.current) return;
        scene = new SplashScene(mountRef.current);
        scene.start();
        setActive(true);
      })
      .catch(() => {
        /* si el diorama falla, la landing estática sigue en pie */
      });

    return () => {
      cancelled = true;
      scene?.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className={`${styles.canvas} ${active ? styles.canvasOn : ""}`}
      aria-hidden
    />
  );
}
