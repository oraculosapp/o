"use client";

import { useEffect, useRef, useState } from "react";
import { thumbUrl } from "@/lib/avatars";
import { NubeLivePreview } from "./nube-live-scene";
import styles from "./avatar-picker.module.css";

export interface AvatarLivePreviewProps {
  /** Color del cuerpo (hex `#rrggbb`) — se aplica EN VIVO al cambiar. */
  color: string;
}

/**
 * Mini-visor 3D EN VIVO del avatar "nube" (reemplaza el retrato estático del
 * selector). Monta {@link NubeLivePreview} en un canvas propio: el avatar camina
 * en el sitio, parpadea y cambia de color al instante. Si WebGL o el GLB fallan,
 * cae con gracia al RETRATO ESTÁTICO tintado (la miniatura + overlay multiply).
 */
export function AvatarLivePreview({ color }: AvatarLivePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<NubeLivePreview | null>(null);
  const [failed, setFailed] = useState(false);
  // Espejo del color para el montaje (evita re-montar el visor al cambiar de color).
  const colorRef = useRef(color);

  // Monta el visor una vez (con el color inicial). Se libera al desmontar el picker.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let preview: NubeLivePreview | null = null;
    try {
      preview = new NubeLivePreview(host, {
        color: colorRef.current,
        onError: () => setFailed(true),
      });
      preview.start();
    } catch {
      setFailed(true);
      return;
    }
    previewRef.current = preview;
    return () => {
      previewRef.current = null;
      preview?.dispose();
    };
    // Monta una sola vez: los cambios de color se propagan por el efecto de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  useEffect(() => {
    colorRef.current = color;
    previewRef.current?.setColor(color);
  }, [color]);

  if (failed) {
    const thumb = thumbUrl();
    return (
      <div className={styles.nubeStage}>
        <div className={styles.nubeFigure}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb} alt="" aria-hidden className={styles.nubeImg} />
          <span
            className={styles.nubeTint}
            aria-hidden
            style={{
              backgroundColor: color,
              WebkitMaskImage: `url(${thumb})`,
              maskImage: `url(${thumb})`,
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.nubeStage}>
      <div ref={hostRef} className={styles.liveHost} aria-hidden />
    </div>
  );
}
