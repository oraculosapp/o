"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  BIO_MAX,
  saveProfile,
  type ProfileData,
  type ProfileProgress,
  type SocialLink,
} from "@/lib/profile";
import { Bell } from "@/components/notifications/Bell";
import { AvatarPicker } from "@/components/avatar-picker/AvatarPicker";
import { ARCHETYPES, thumbUrl } from "@/lib/avatars";
import {
  getStoredAvatar,
  saveAvatarToProfile,
  storeAvatar,
  type AvatarSelection,
} from "@/lib/avatar-store";
import { BIOSPHERE_RUNES } from "./biospheres";
import styles from "./profile.module.css";

export interface ProfileFormProps {
  userId: string;
  initial: ProfileData | null;
  progress: ProfileProgress | null;
}

interface Toast {
  id: number;
  kind: "success" | "error";
  text: string;
}

const EMPTY: ProfileData = {
  handle: "",
  bio: "",
  website: "",
  social: [],
  birthdate: "",
  location: "",
  birthdatePublic: false,
  locationPublic: false,
};

/**
 * Formulario de marca del perfil propio: paneles glass, píldoras, focus dorado.
 * Guardado OPTIMISTA con toasts (patrón selbar) de éxito/error. Los campos
 * sensibles (nacimiento, ubicación) llevan su toggle público/privado individual.
 */
export function ProfileForm({ userId, initial, progress }: ProfileFormProps) {
  const [data, setData] = useState<ProfileData>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [avatarSel, setAvatarSel] = useState<AvatarSelection | null>(() => getStoredAvatar());
  const [pickerOpen, setPickerOpen] = useState(false);

  const set = useCallback(<K extends keyof ProfileData>(key: K, value: ProfileData[K]) => {
    setData((d) => ({ ...d, [key]: value }));
  }, []);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  // --- Avatar (arquetipo + tinte) --------------------------------------------
  const onApplyAvatar = useCallback(
    (sel: AvatarSelection) => {
      storeAvatar(sel);
      void saveAvatarToProfile(sel);
      setAvatarSel(sel);
      setPickerOpen(false);
      pushToast("success", "Avatar actualizado ✦");
    },
    [pushToast],
  );

  // --- Redes sociales (lista dinámica) ---------------------------------------
  const addSocial = useCallback(() => {
    setData((d) => ({ ...d, social: [...d.social, { label: "", url: "" }] }));
  }, []);
  const updateSocial = useCallback((i: number, patch: Partial<SocialLink>) => {
    setData((d) => ({
      ...d,
      social: d.social.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  }, []);
  const removeSocial = useCallback((i: number) => {
    setData((d) => ({ ...d, social: d.social.filter((_, idx) => idx !== i) }));
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (saving) return;
      setHandleError(null);
      setSaving(true);
      // Optimista: el toast de éxito se muestra en cuanto la promesa resuelve OK.
      const res = await saveProfile(userId, data);
      setSaving(false);
      if (res.ok) {
        pushToast("success", "Perfil guardado ✦");
      } else {
        if (res.field === "handle") setHandleError(res.message);
        pushToast("error", res.message);
      }
    },
    [data, saving, userId, pushToast]
  );

  const bioLeft = BIO_MAX - data.bio.length;
  const found = useMemo(() => new Set(progress?.foundOracles ?? []), [progress]);
  const unlocked = useMemo(() => new Set(progress?.unlockedBiospheres ?? ["paqo"]), [progress]);

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/b/paqo" className={styles.backLink}>
          ← Al mundo
        </Link>
        <h1 className={styles.pageTitle}>Tu perfil</h1>
        <Bell />
      </header>

      <form className={styles.form} onSubmit={onSubmit}>
        {/* --- Identidad ------------------------------------------------------ */}
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Identidad</h2>

          <label className={styles.field}>
            <span className={styles.label}>Handle</span>
            <div className={styles.handleRow}>
              <span className={styles.at} aria-hidden>
                @
              </span>
              <input
                className={`${styles.input} ${handleError ? styles.inputError : ""}`}
                value={data.handle}
                onChange={(e) => {
                  set("handle", e.target.value.toLowerCase());
                  if (handleError) setHandleError(null);
                }}
                placeholder="tu-handle"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(handleError)}
                aria-describedby={handleError ? "handle-error" : undefined}
              />
            </div>
            {handleError ? (
              <span id="handle-error" className={styles.errorText} role="alert">
                {handleError}
              </span>
            ) : (
              <span className={styles.hint}>Tu nombre único en Phygitalia.</span>
            )}
          </label>

          <label className={styles.field}>
            <span className={styles.label}>
              Bio
              <span className={`${styles.counter} ${bioLeft < 0 ? styles.counterOver : ""}`}>
                {bioLeft}
              </span>
            </span>
            <textarea
              className={styles.textarea}
              value={data.bio}
              maxLength={BIO_MAX}
              rows={3}
              onChange={(e) => set("bio", e.target.value)}
              placeholder="Cuéntale al mundo quién eres…"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Sitio web</span>
            <input
              className={styles.input}
              type="url"
              inputMode="url"
              value={data.website}
              onChange={(e) => set("website", e.target.value)}
              placeholder="https://…"
            />
          </label>
        </section>

        {/* --- Avatar --------------------------------------------------------- */}
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Avatar</h2>
          <p className={styles.panelLead}>
            Tu arquetipo y su color te acompañan por todas las Biósferas.
          </p>
          <div className={styles.avatarRow}>
            <div className={styles.avatarPreview}>
              {avatarSel ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbUrl(avatarSel.archetype)} alt="" className={styles.avatarThumb} />
              ) : (
                <span className={styles.avatarEmpty} aria-hidden />
              )}
            </div>
            <div className={styles.avatarMeta}>
              <span className={styles.avatarName}>
                {avatarSel
                  ? (ARCHETYPES.find((a) => a.id === avatarSel.archetype)?.name ?? avatarSel.archetype)
                  : "Sin elegir todavía"}
              </span>
              {avatarSel && (
                <span
                  className={styles.avatarTint}
                  title="Color primario"
                  style={{ background: avatarSel.tint.primary }}
                  aria-hidden
                />
              )}
            </div>
            <button
              type="button"
              className={styles.avatarBtn}
              onClick={() => setPickerOpen(true)}
            >
              Cambiar avatar
            </button>
          </div>
        </section>

        {/* --- Redes sociales ------------------------------------------------- */}
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Redes sociales</h2>
          {data.social.length === 0 && (
            <p className={styles.emptyRow}>Aún no has añadido enlaces.</p>
          )}
          <ul className={styles.socialList}>
            {data.social.map((s, i) => (
              <li key={i} className={styles.socialRow}>
                <input
                  className={styles.socialLabel}
                  value={s.label}
                  onChange={(e) => updateSocial(i, { label: e.target.value })}
                  placeholder="Etiqueta"
                  aria-label={`Etiqueta del enlace ${i + 1}`}
                />
                <input
                  className={styles.socialUrl}
                  type="url"
                  inputMode="url"
                  value={s.url}
                  onChange={(e) => updateSocial(i, { url: e.target.value })}
                  placeholder="https://…"
                  aria-label={`URL del enlace ${i + 1}`}
                />
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => removeSocial(i)}
                  aria-label={`Quitar enlace ${i + 1}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.addBtn} onClick={addSocial}>
            + Añadir enlace
          </button>
        </section>

        {/* --- Datos sensibles (toggle público/privado individual) ----------- */}
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Datos personales</h2>
          <p className={styles.panelLead}>
            Tú decides qué se ve en tu perfil público. Lo privado sólo lo ves tú.
          </p>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="profile-birthdate">
              Fecha de nacimiento
            </label>
            <div className={styles.sensitiveRow}>
              <input
                id="profile-birthdate"
                className={styles.input}
                type="date"
                value={data.birthdate}
                onChange={(e) => set("birthdate", e.target.value)}
              />
              <PrivacyToggle
                on={data.birthdatePublic}
                onToggle={() => set("birthdatePublic", !data.birthdatePublic)}
                label="Visibilidad de la fecha de nacimiento"
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="profile-location">
              Ubicación
            </label>
            <div className={styles.sensitiveRow}>
              <input
                id="profile-location"
                className={styles.input}
                type="text"
                value={data.location}
                onChange={(e) => set("location", e.target.value)}
                placeholder="Ciudad, país…"
              />
              <PrivacyToggle
                on={data.locationPublic}
                onToggle={() => set("locationPublic", !data.locationPublic)}
                label="Visibilidad de la ubicación"
              />
            </div>
          </div>
        </section>

        {/* --- Tu viaje ------------------------------------------------------- */}
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Tu viaje</h2>
          {progress?.arrivedAt && (
            <p className={styles.arrived}>
              Llegaste a Phygitalia el{" "}
              <b>
                {new Date(progress.arrivedAt).toLocaleDateString("es-ES", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </b>
              .
            </p>
          )}
          <ul className={styles.runes}>
            {BIOSPHERE_RUNES.map((b) => {
              const isFound = found.has(b.id);
              const isUnlocked = unlocked.has(b.id);
              const lit = isFound || isUnlocked;
              return (
                <li
                  key={b.id}
                  className={`${styles.rune} ${lit ? styles.runeLit : styles.runeDim}`}
                  title={
                    isFound
                      ? `${b.name} · encontrado`
                      : isUnlocked
                        ? `${b.name} · desbloqueada`
                        : `${b.name} · por descubrir`
                  }
                >
                  <span className={styles.runeGlyph} aria-hidden />
                  <span className={styles.runeName}>{b.name}</span>
                  <span className={styles.runeState}>
                    {isFound ? "Encontrado" : isUnlocked ? "Desbloqueada" : "Próximamente"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <div className={styles.actions}>
          <button type="submit" className={styles.save} disabled={saving}>
            {saving ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </form>

      {/* Toasts (selbar): píldoras glass flotantes abajo-centro. */}
      <div className={styles.toasts} aria-live="polite" role="status">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${styles.toast} ${t.kind === "error" ? styles.toastError : styles.toastOk}`}
          >
            {t.text}
          </div>
        ))}
      </div>

      <AvatarPicker
        open={pickerOpen}
        initial={avatarSel}
        onClose={() => setPickerOpen(false)}
        onApply={onApplyAvatar}
      />
    </div>
  );
}

/** Interruptor público/privado con estado claro (etiqueta + switch). */
function PrivacyToggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle(): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${styles.toggle} ${on ? styles.toggleOn : styles.toggleOff}`}
      onClick={onToggle}
    >
      <span className={styles.toggleText}>{on ? "Público" : "Privado"}</span>
      <span className={styles.toggleKnob} aria-hidden />
    </button>
  );
}
