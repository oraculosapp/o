"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarLab, type LabMode } from "./lab";
import styles from "./avatar.module.css";

const MODES: LabMode[] = ["idle", "walk", "run", "jump"];

/** Paletas de prueba para setTint (3 swatches). */
const PALETTES: { name: string; primary: string; secondary: string; hair: string }[] = [
  { name: "Bosque", primary: "#6b8e4e", secondary: "#c9a96b", hair: "#3a2f18" },
  { name: "Vampiro", primary: "#8e1b2e", secondary: "#141726", hair: "#0e1512" },
  { name: "Neón", primary: "#8ace3b", secondary: "#2ab7ff", hair: "#e3b063" },
];

export default function AvatarDevPage() {
  // Ruta solo-dev: en producción sin ?dev=1 → redirect a /.
  const [allowed, setAllowed] = useState<boolean | null>(
    process.env.NODE_ENV !== "production" ? true : null,
  );

  useEffect(() => {
    if (allowed !== null) return;
    const dev = new URLSearchParams(window.location.search).has("dev");
    if (dev) setAllowed(true);
    else window.location.replace("/");
  }, [allowed]);

  if (allowed !== true) return null;
  return <AvatarLabView />;
}

function AvatarLabView() {
  const mountRef = useRef<HTMLDivElement>(null);
  const labRef = useRef<AvatarLab | null>(null);
  const [mode, setMode] = useState<LabMode>("idle");
  const [glb, setGlb] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const lab = new AvatarLab(el);
    labRef.current = lab;
    lab.start();
    return () => {
      lab.dispose();
      labRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const pickMode = (m: LabMode) => {
    setMode(m);
    labRef.current?.setMode(m);
  };

  const applyTint = (p: (typeof PALETTES)[number]) => {
    labRef.current?.setTint({ primary: p.primary, secondary: p.secondary, hair: p.hair });
  };

  const tryLoad = async () => {
    const name = glb.trim();
    if (!name) return;
    const res = await labRef.current?.loadGlb(name);
    if (res && !res.ok) {
      setToast(`No se pudo cargar “${name}.glb”. Sigue el maniquí de prueba. (${res.error ?? "error"})`);
    } else if (res?.ok) {
      setToast(`Cargado ${name}.glb ✓`);
    }
  };

  return (
    <main className={styles.stage}>
      <div ref={mountRef} className={styles.canvas} />

      {toast && (
        <div className={styles.toast} role="status" aria-live="polite">
          {toast}
        </div>
      )}

      <section className={styles.panel} aria-label="Controles de avatar">
        <h1 className={styles.title}>AVATAR · DEV</h1>

        <div>
          <div className={styles.label}>Animación</div>
          <div className={styles.row}>
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`${styles.btn} ${mode === m ? styles.btnActive : ""}`}
                onClick={() => pickMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.label}>Tinte (setTint)</div>
          <div className={styles.row}>
            {PALETTES.map((p) => (
              <button
                key={p.name}
                type="button"
                className={styles.swatch}
                title={p.name}
                aria-label={`Paleta ${p.name}`}
                style={{
                  background: `linear-gradient(135deg, ${p.primary} 0 55%, ${p.secondary} 55% 80%, ${p.hair} 80% 100%)`,
                }}
                onClick={() => applyTint(p)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className={styles.label}>Cargar GLB Tripo3D</div>
          <div className={styles.glbRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="p.ej. hacker-m"
              value={glb}
              onChange={(e) => setGlb(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void tryLoad();
              }}
            />
            <button type="button" className={styles.btn} onClick={() => void tryLoad()}>
              Cargar
            </button>
          </div>
          <p className={styles.hint}>
            Busca en <code>/assets/avatars/&lt;nombre&gt;.glb</code>. Si falla, sigue el maniquí.
          </p>
        </div>
      </section>
    </main>
  );
}
