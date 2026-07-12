import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchPublicProfile, type PublicProfile } from "@/lib/supabase-public";
import styles from "./u.module.css";

interface PageParams {
  params: Promise<{ handle: string }>;
}

/**
 * Perfil PÚBLICO `/u/[handle]`. Server Component: lee la vista `public_profiles`
 * (que aplica los flags de privacidad server-side), 404 digno si no existe, y
 * metadata OpenGraph por perfil.
 */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { handle } = await params;
  const profile = await fetchPublicProfile(handle);
  if (!profile) {
    return { title: "Perfil no encontrado — Phygitalia" };
  }
  const title = `@${profile.handle} — Phygitalia`;
  const description = profile.bio?.trim()
    ? profile.bio.trim().slice(0, 160)
    : `El perfil de @${profile.handle} en el mundo de los Oráculos Telúrico-Sintéticos.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "profile",
      locale: "es_ES",
      url: `/u/${profile.handle}`,
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function PublicProfilePage({ params }: PageParams) {
  const { handle } = await params;
  const profile = await fetchPublicProfile(handle);
  if (!profile) notFound();

  const social = normalizeSocial(profile);
  const initial = profile.handle.charAt(0).toUpperCase();

  return (
    <main className={styles.page}>
      <div className={styles.nebula} aria-hidden />

      <article className={styles.card}>
        <header className={styles.head}>
          <span className={styles.avatar} aria-hidden>
            {initial}
          </span>
          <h1 className={styles.handle}>@{profile.handle}</h1>
        </header>

        {profile.bio && <p className={styles.bio}>{profile.bio}</p>}

        <dl className={styles.meta}>
          {profile.location && (
            <div className={styles.metaRow}>
              <dt className={styles.metaKey}>Ubicación</dt>
              <dd className={styles.metaVal}>{profile.location}</dd>
            </div>
          )}
          {profile.birthdate && (
            <div className={styles.metaRow}>
              <dt className={styles.metaKey}>Nacimiento</dt>
              <dd className={styles.metaVal}>{formatDate(profile.birthdate)}</dd>
            </div>
          )}
          <div className={styles.metaRow}>
            <dt className={styles.metaKey}>En Phygitalia desde</dt>
            <dd className={styles.metaVal}>{formatDate(profile.created_at)}</dd>
          </div>
        </dl>

        {(profile.website || social.length > 0) && (
          <div className={styles.links}>
            {profile.website && (
              <a
                className={styles.link}
                href={profile.website}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                Sitio web
              </a>
            )}
            {social.map(({ label, url }) => (
              <a
                key={label}
                className={styles.link}
                href={url}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                {label}
              </a>
            ))}
          </div>
        )}

        <footer className={styles.foot}>
          <Link href="/b/paqo" className={styles.enter}>
            Entrar a Phygitalia
          </Link>
        </footer>
      </article>
    </main>
  );
}

function normalizeSocial(profile: PublicProfile): Array<{ label: string; url: string }> {
  const raw = profile.social;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([label, v]) => ({ label, url: String(v) }));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
}
