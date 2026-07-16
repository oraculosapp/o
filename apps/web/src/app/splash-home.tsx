"use client";

// ⚠️ DESCONECTADO (S8, dirección "nube"): la raíz (page.tsx) ES el mundo y entra
// directo con color+nombre aleatorios. Este splash ceremonial (ruleta 3D de
// arquetipos) se conserva por si se reactiva como página de marca más adelante;
// solo se adaptó al nuevo avatar-store `{ color }` para que siga compilando.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ARCHETYPES } from "@/lib/avatars";
import { defaultSelection, getStoredAvatar, storeAvatar } from "@/lib/avatar-store";
import { getStoredName, storeName } from "@/lib/oracle-client";
import type { AvatarCarousel } from "./avatar-carousel";
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

const NICK_MIN = 2;
const NICK_MAX = 20;

/**
 * Isla interactiva del Splash: nickname + RULETA 3D ceremonial de los 9 arquetipos
 * PROCEDURALES + ENTRAR.
 *
 * La ruleta ({@link AvatarCarousel}) monta una mini-escena three.js con un piso
 * circular (runa dorada al centro) y los 9 avatares dispuestos EN CÍRCULO; el
 * usuario la gira (arrastrar horizontal, botones ‹ ›, o flechas) para traer al
 * frente el avatar deseado, que se resalta y se acerca. Se carga de forma diferida
 * y aparece en fade al montar; sin WebGL, el selector sigue funcionando por
 * nombres/pager. La marca (logo/nebulosa/footer) la pinta el page.tsx (SSR).
 *
 * Fuente de verdad = el índice de React; la ruleta reporta los giros por arrastre
 * (`onSelect`) y recibe los cambios programáticos (`goTo`).
 */
export default function SplashHome() {
  const router = useRouter();
  const stored = typeof window !== "undefined" ? getStoredAvatar() : null;
  // Con el diseño único "nube" ya no hay arquetipo guardado: la ruleta (dead
  // code decorativo) arranca siempre en el primero.
  const initialIndex = 0;

  const [nick, setNick] = useState("");
  const [index, setIndex] = useState<number>(initialIndex);
  const [error, setError] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const [entering, setEntering] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<AvatarCarousel | null>(null);
  const nickRef = useRef<HTMLInputElement>(null);
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Índice más reciente disponible dentro del callback del carousel (sin stale closure).
  const indexRef = useRef(index);
  indexRef.current = index;
  // Conserva el color de la selección previa (o uno pastel aleatorio).
  const colorRef = useRef<string>(stored?.color ?? defaultSelection().color);

  // Prefill del nick guardado (cliente).
  useEffect(() => {
    const saved = getStoredName();
    if (saved) setNick(saved);
  }, []);

  // Monta la ruleta 3D diferida (fuera del bundle inicial) sobre el escenario.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !hasWebGL()) return;

    const reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    let cancelled = false;
    import("./avatar-carousel")
      .then(({ AvatarCarousel }) => {
        if (cancelled || !stageRef.current) return;
        const c = new AvatarCarousel(
          stageRef.current,
          ARCHETYPES.map((a) => a.id),
          {
            reducedMotion: reduced,
            initialIndex: indexRef.current,
            onSelect: (i) => setIndex(i),
          },
        );
        c.start();
        carouselRef.current = c;
        setPreviewOn(true);
      })
      .catch(() => {
        /* si la ruleta 3D falla, la isla sigue con el pager por nombres */
      });

    return () => {
      cancelled = true;
      carouselRef.current?.dispose();
      carouselRef.current = null;
    };
    // Se monta una sola vez; los cambios de índice van por el efecto de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincroniza la ruleta con la selección programática (botones/dots/flechas).
  // El guard interno de `goTo` evita reñir con el arrastre (que ya fijó el índice).
  useEffect(() => {
    carouselRef.current?.goTo(index);
  }, [index]);

  const archetype = ARCHETYPES[index]?.id ?? ARCHETYPES[0].id;
  const activeName = ARCHETYPES[index]?.name ?? archetype;

  const select = (i: number) => {
    const norm = ((i % ARCHETYPES.length) + ARCHETYPES.length) % ARCHETYPES.length;
    setIndex(norm);
  };

  // Roving tabindex + flechas por el pager (patrón radiogroup, WCAG 4.1.2).
  const onPagerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next = index;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ARCHETYPES.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const norm = ((next % ARCHETYPES.length) + ARCHETYPES.length) % ARCHETYPES.length;
    setIndex(norm);
    dotRefs.current[norm]?.focus();
  };

  const enter = () => {
    const clean = nick.trim();
    if (clean.length < NICK_MIN) {
      setError(true);
      nickRef.current?.focus();
      return;
    }
    setEntering(true);
    storeName(clean);
    // S8: el avatar es único ("nube"); solo se persiste el color del viajero.
    storeAvatar({ color: colorRef.current });
    router.push("/");
  };

  return (
    <div className={styles.island}>
      {/* Ruleta 3D de avatares (fade-in al montar). Sin WebGL: vacío + pager. */}
      <div className={styles.stageWrap}>
        <button
          type="button"
          className={`${styles.ringNav} ${styles.ringNavPrev}`}
          onClick={() => select(index - 1)}
          aria-label="Girar a la izquierda"
        >
          ‹
        </button>

        <div
          ref={stageRef}
          className={`${styles.stage} ${previewOn ? styles.stageOn : ""}`}
          aria-hidden
        />

        <button
          type="button"
          className={`${styles.ringNav} ${styles.ringNavNext}`}
          onClick={() => select(index + 1)}
          aria-label="Girar a la derecha"
        >
          ›
        </button>

        <span className={styles.stageName} aria-live="polite">
          {activeName}
        </span>
      </div>

      {/* Pager accesible: los 9 arquetipos como radiogroup (dots). */}
      <div
        className={styles.pager}
        role="radiogroup"
        aria-label="Elige tu arquetipo"
        onKeyDown={onPagerKey}
      >
        {ARCHETYPES.map((a, i) => {
          const active = i === index;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={a.name}
              tabIndex={active ? 0 : -1}
              ref={(el) => {
                dotRefs.current[i] = el;
              }}
              className={`${styles.dot} ${active ? styles.dotActive : ""}`}
              onClick={() => select(i)}
              title={a.name}
            />
          );
        })}
      </div>

      {/* Nickname + ENTRAR */}
      <form
        className={styles.entry}
        onSubmit={(e) => {
          e.preventDefault();
          enter();
        }}
      >
        <label className={styles.nickLabel} htmlFor="splash-nick">
          Tu nombre de viajero
        </label>
        <div className={styles.entryRow}>
          <input
            id="splash-nick"
            ref={nickRef}
            className={`${styles.nick} ${error ? styles.nickError : ""}`}
            placeholder="¿Cómo te llamas, viajero?"
            value={nick}
            minLength={NICK_MIN}
            maxLength={NICK_MAX}
            autoComplete="off"
            aria-describedby={error ? "splash-nick-hint" : undefined}
            aria-invalid={error || undefined}
            onChange={(e) => {
              setNick(e.target.value);
              if (error) setError(false);
            }}
          />
          <button type="submit" className={styles.enter} disabled={entering}>
            ENTRAR
          </button>
        </div>
        {error && (
          <span id="splash-nick-hint" className={styles.nickHint} role="alert">
            Escribe un nombre (2–20 caracteres) para cruzar el umbral.
          </span>
        )}
      </form>
    </div>
  );
}
