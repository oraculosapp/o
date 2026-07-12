"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RegisterModal } from "@/components/auth/RegisterModal";
import { isSupabaseConfigured } from "@/lib/notifications";
import {
  getProfileSession,
  loadProfile,
  loadProgress,
  type ProfileData,
  type ProfileProgress,
} from "@/lib/profile";
import { ProfileForm } from "./ProfileForm";
import styles from "./profile.module.css";

type Phase = "loading" | "invite" | "editing" | "unconfigured";

/**
 * Orquestador de `/usuario`. Decide entre:
 *   · invitación elegante (sesión anónima o sin cuenta) → RegisterModal.
 *   · formulario de edición (usuario registrado).
 *
 * La sesión vive en localStorage (cliente); por eso el shell es server pero los
 * datos se cargan aquí. Degrada con gracia si Supabase no está configurado.
 */
export function UsuarioClient() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [userId, setUserId] = useState<string>("");
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [progress, setProgress] = useState<ProfileProgress | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setPhase("unconfigured");
      return;
    }
    let cancelled = false;
    void (async () => {
      const session = await getProfileSession();
      if (cancelled) return;
      if (!session || !session.registered) {
        setPhase("invite");
        return;
      }
      const [prof, prog] = await Promise.all([loadProfile(), loadProgress()]);
      if (cancelled) return;
      setUserId(session.userId);
      setProfile(prof);
      setProgress(prog);
      setPhase("editing");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "loading") {
    return (
      <div className={styles.center} role="status" aria-live="polite">
        <div className={styles.rune} aria-hidden />
        <span className={styles.loadingLabel}>CARGANDO</span>
      </div>
    );
  }

  if (phase === "unconfigured") {
    return (
      <div className={styles.center}>
        <p className={styles.dimNote}>Perfil en reposo · falta configurar Supabase</p>
        <Link href="/b/paqo" className={styles.backLink}>
          ← Volver al mundo
        </Link>
      </div>
    );
  }

  if (phase === "invite") {
    return (
      <>
        <section className={styles.invite}>
          <span className={styles.inviteRune} aria-hidden />
          <h1 className={styles.inviteTitle}>Crea tu cuenta</h1>
          <p className={styles.inviteLead}>
            Deja tu correo y los Oráculos <b>te recordarán</b>: tu nombre, tu viaje por las
            Biósferas y tus conversaciones con Paqo te seguirán a cualquier dispositivo.
          </p>
          <button
            type="button"
            className={styles.invitePrimary}
            onClick={() => setShowRegister(true)}
          >
            Que Paqo me recuerde
          </button>
          <Link href="/b/paqo" className={styles.backLink}>
            Seguir explorando sin cuenta →
          </Link>
        </section>
        {showRegister && <RegisterModal onClose={() => setShowRegister(false)} />}
      </>
    );
  }

  // phase === "editing"
  return <ProfileForm userId={userId} initial={profile} progress={progress} />;
}
