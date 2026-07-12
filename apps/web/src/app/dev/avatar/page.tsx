"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarLab, type LabMode, type ClipInfo } from "./lab";
import { avatarFileNames } from "@/lib/avatars";
import styles from "./avatar.module.css";

const MODES: LabMode[] = ["idle", "walk", "run", "jump"];
const LOCOMOTIONS: LabMode[] = ["idle", "walk", "run", "jump"];
const AVATAR_NAMES = avatarFileNames(); // los 18 nombres de la convención

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
  const [clips, setClips] = useState<ClipInfo | null>(null);

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

  const loadName = async (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const res = await labRef.current?.loadGlb(clean);
    if (res && !res.ok) {
      setClips(null);
      setToast(`No se pudo cargar “${clean}.glb”. Sigue el maniquí de prueba. (${res.error ?? "error"})`);
    } else if (res?.ok) {
      setClips(res.clips);
      setToast(`Cargado ${clean}.glb ✓`);
    }
  };

  const tryLoad = () => loadName(glb);

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
          <div className={styles.label}>Arquetipos (convención)</div>
          <div className={styles.glbRow}>
            <select
              className={styles.input}
              value=""
              onChange={(e) => {
                const name = e.target.value;
                if (!name) return;
                setGlb(name);
                void loadName(name);
              }}
              aria-label="Elegir arquetipo por nombre"
            >
              <option value="">— elige uno de los 18 —</option>
              {AVATAR_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <p className={styles.hint}>
            Prueba de un clic los 18 nombres a medida que lleguen los riggeados.
          </p>
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

        {clips && (
          <div>
            <div className={styles.label}>Clips del GLB</div>
            <ul className={styles.clipMap}>
              {LOCOMOTIONS.map((loco) => {
                const real = clips.mapping[loco];
                return (
                  <li key={loco} className={styles.clipRow}>
                    <span className={styles.clipKey}>{loco}</span>
                    <span className={styles.clipArrow} aria-hidden>
                      →
                    </span>
                    <span className={real ? styles.clipVal : styles.clipMissing}>
                      {real ?? "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className={styles.hint}>
              {clips.names.length > 0
                ? `Trae ${clips.names.length} clip(s): ${clips.names.join(", ")}`
                : "El GLB no trae clips de animación."}
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
