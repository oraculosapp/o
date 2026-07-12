"use client";

/**
 * Galería temporal de arquetipos (solo /dev) para validar visualmente los 9
 * avatares PROCEDURALES: una cuadrícula 3×3 de ArchetypePreview, cada uno en su
 * mini-escena (fondo transparente, luz toon), girando lento. Un toggle alterna
 * idle/caminar para comprobar la locomoción. Herramienta de QA del escultor de
 * personajes; no forma parte del producto.
 */

import { useEffect, useRef, useState } from "react";
import { ArchetypePreview, ARCHETYPE_IDS, archetypeSpec } from "@phygitalia/engine";

function Cell({ id, walk }: { id: string; walk: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const previewRef = useRef<ArchetypePreview | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = new ArchetypePreview(el, id, { walk, autoRotate: true, rotateSpeed: 0.6 });
    previewRef.current = p;
    p.start();
    return () => {
      p.dispose();
      previewRef.current = null;
    };
    // Recrea al cambiar walk (rehace el rig con el estado correcto).
  }, [id, walk]);

  const name = archetypeSpec(id).name;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        ref={ref}
        data-archetype={id}
        style={{
          width: "100%",
          aspectRatio: "3 / 4",
          background: "radial-gradient(circle at 50% 35%, #2a2440, #12101c)",
          borderRadius: 12,
          border: "1px solid #33304a",
          overflow: "hidden",
        }}
      />
      <span style={{ marginTop: 6, color: "#d8d2ea", font: "600 14px system-ui", letterSpacing: 0.4 }}>
        {name}
      </span>
    </div>
  );
}

export default function GalleryPage() {
  const [walk, setWalk] = useState(true);
  return (
    <main style={{ minHeight: "100vh", background: "#0c0b14", padding: 24, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <h1 style={{ color: "#f0ecff", font: "700 20px system-ui", margin: 0 }}>
          Arquetipos procedurales · {ARCHETYPE_IDS.length}
        </h1>
        <button
          type="button"
          onClick={() => setWalk((w) => !w)}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid #4a4666",
            background: walk ? "#8ace3b" : "#1c1a2a",
            color: walk ? "#12101c" : "#d8d2ea",
            font: "600 13px system-ui",
            cursor: "pointer",
          }}
        >
          {walk ? "Caminando ▸ idle" : "Idle ▸ caminar"}
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 18,
          maxWidth: 1100,
          margin: "0 auto",
        }}
      >
        {ARCHETYPE_IDS.map((id) => (
          <Cell key={id} id={id} walk={walk} />
        ))}
      </div>
    </main>
  );
}
