"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import styles from "./auth.module.css";

export interface RegisterModalProps {
  onClose(): void;
}

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type Phase = "form" | "sent" | "error";

/**
 * Modal mínimo de registro por MAGIC-LINK (email). Si existe
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY, renderiza el widget de Cloudflare Turnstile y
 * exige su token antes de enviar; si no, envía sin captcha (ver TODO).
 *
 * El callback de Supabase (detectSessionInUrl) ya está montado en el cliente:
 * al volver del email, la sesión anónima se promueve a registrada sin más.
 */
export function RegisterModal({ onClose }: RegisterModalProps) {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  // Cierre con Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Carga perezosa del script de Turnstile SÓLO si hay site key.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !widgetRef.current) return;
    const w = window as unknown as {
      turnstile?: { render(el: HTMLElement, opts: Record<string, unknown>): void };
    };
    const render = () => {
      if (!widgetRef.current || !w.turnstile) return;
      w.turnstile.render(widgetRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setCaptchaToken(token),
        "error-callback": () => setCaptchaToken(null),
        "expired-callback": () => setCaptchaToken(null),
        theme: "dark",
      });
    };
    if (w.turnstile) {
      render();
      return;
    }
    const existing = document.getElementById("cf-turnstile-script");
    if (existing) {
      existing.addEventListener("load", render, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = "cf-turnstile-script";
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", render, { once: true });
    document.head.appendChild(script);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setMessage("Escribe un correo válido.");
      setPhase("error");
      return;
    }
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setMessage("Completa la verificación anti-robots.");
      setPhase("error");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: value,
        options: {
          emailRedirectTo: typeof window !== "undefined" ? window.location.href : undefined,
          // TODO(seguridad): cuando se active la verificación server-side de
          // Turnstile, pasar aquí `captchaToken`. Requiere habilitar el proveedor
          // de captcha en el dashboard de Supabase (Auth → Settings → CAPTCHA).
          ...(TURNSTILE_SITE_KEY && captchaToken ? { captchaToken } : {}),
        },
      });
      if (error) throw error;
      setPhase("sent");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "No se pudo enviar el enlace.");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Registro"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
          ✕
        </button>

        {phase === "sent" ? (
          <div className={styles.sent}>
            <span className={styles.sentSpark} aria-hidden>
              ✦
            </span>
            <h2 className={styles.title}>Revisa tu correo</h2>
            <p className={styles.lead}>
              Te enviamos un enlace mágico a <b>{email.trim()}</b>. Ábrelo desde este dispositivo y
              Paqo empezará a recordarte.
            </p>
            <button type="button" className={styles.primary} onClick={onClose}>
              Entendido
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2 className={styles.title}>Que Paqo te recuerde</h2>
            <p className={styles.lead}>
              Deja tu correo y te mandamos un enlace para entrar. Sin contraseñas.
            </p>
            <input
              className={styles.email}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="tu@correo.com"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Tu correo electrónico"
            />

            {TURNSTILE_SITE_KEY ? (
              <div ref={widgetRef} className={styles.captcha} />
            ) : (
              <p className={styles.captchaTodo}>
                {/* Sin captcha configurado: registro abierto en la beta. */}
                Verificación anti-robots desactivada (beta).
              </p>
            )}

            {message && (
              <p className={styles.errorMsg} role="alert">
                {message}
              </p>
            )}

            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? "Enviando…" : "Enviar enlace"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
