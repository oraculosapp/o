"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { isSupabaseConfigured } from "@/lib/realtime";
import { RegisterModal } from "@/components/auth/RegisterModal";
import styles from "./account-fab.module.css";

type Auth = "loading" | "anon" | "registered";

/**
 * FAB de CUENTA (arriba-derecha, junto a la campanita): botón flotante glass que
 * despliega un menú de marca con las opciones según la sesión:
 *   · anónimo    → "Crear cuenta" · "Entrar"  (abren el RegisterModal magic-link)
 *   · registrado → "Mi perfil" (/usuario) · "Cerrar sesión" (signOut de Supabase)
 *
 * Accesible: `aria-haspopup="menu"`, `aria-expanded`, foco al primer ítem al abrir,
 * Escape cierra y devuelve el foco al botón, clic fuera cierra, anillo de foco
 * dorado. Reemplaza el antiguo enlace "Perfil" del HUD; la campanita y el mute se
 * quedan donde estaban.
 */
export function AccountFab() {
  const router = useRouter();
  const [auth, setAuth] = useState<Auth>("loading");
  const [open, setOpen] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const menuId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);

  // Escucha la sesión de Supabase (si está configurado). Anónimo o sin sesión →
  // "anon"; usuario con email (no anónimo) → "registered".
  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setAuth("anon");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    let active = true;
    const resolve = (isAnon: boolean | undefined, hasUser: boolean) =>
      setAuth(hasUser && isAnon !== true ? "registered" : "anon");

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      resolve(data.session?.user?.is_anonymous, !!data.session?.user);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (!active) return;
      resolve(session?.user?.is_anonymous, !!session?.user);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Clic fuera cierra el menú.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Escape cierra y devuelve el foco al botón; enfoca el primer ítem al abrir.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    firstItemRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openRegister = () => {
    setShowRegister(true);
    setOpen(false);
  };

  const goProfile = () => {
    setOpen(false);
    router.push("/usuario");
  };

  const signOut = async () => {
    setOpen(false);
    try {
      if (isSupabaseConfigured()) await getSupabaseBrowserClient().auth.signOut();
    } catch {
      /* sesión ya caída: no es crítico */
    }
    // La sesión anónima se restablecerá al volver a entrar a una biósfera.
    setAuth("anon");
  };

  const registered = auth === "registered";

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.fab} ${styles.tip}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Tu cuenta"
        data-tip="Tu cuenta"
        onClick={() => setOpen((v) => !v)}
      >
        <AccountGlyph registered={registered} />
      </button>

      {open && (
        <div className={styles.menu} role="menu" id={menuId} aria-label="Opciones de cuenta">
          {registered ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                ref={(el) => {
                  firstItemRef.current = el;
                }}
                onClick={goProfile}
              >
                Mi perfil
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={signOut}
              >
                Cerrar sesión
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                ref={(el) => {
                  firstItemRef.current = el;
                }}
                onClick={openRegister}
              >
                Crear cuenta
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={openRegister}
              >
                Entrar
              </button>
            </>
          )}
        </div>
      )}

      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
    </div>
  );
}

/** Glifo de cuenta: silueta de persona; con un ✦ dorado si la sesión es registrada. */
function AccountGlyph({ registered }: { registered: boolean }) {
  return (
    <span className={styles.glyphWrap}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M5.5 19.5c.7-3.3 3.3-5 6.5-5s5.8 1.7 6.5 5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      {registered && (
        <span className={styles.badge} aria-hidden>
          ✦
        </span>
      )}
    </span>
  );
}
