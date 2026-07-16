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
    return { title: "Perfil no encontrado" };
  }
  const title = `@${profile.handle}`;
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

  // Defensa en profundidad anti-XSS (C-1): aunque profile.ts ya sanea al guardar,
  // este es un Server Component y el `href` se emite crudo en el SSR. Revalidamos
  // el esquema aquí y descartamos cualquier enlace que no sea http/https.
  const website = profile.website ? safeHref(profile.website) : null;
  const social = normalizeSocial(profile)
    .map(({ label, url }) => ({ label, href: safeHref(url) }))
    .filter((s): s is { label: string; href: string } => s.href !== null);
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

        {(website || social.length > 0) && (
          <div className={styles.links}>
            {website && (
              <a
                className={styles.link}
                href={website}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                Sitio web
              </a>
            )}
            {social.map(({ label, href }) => (
              <a
                key={label}
                className={styles.link}
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                {label}
              </a>
            ))}
          </div>
        )}

        <footer className={styles.foot}>
          <Link href="/" className={styles.enter}>
            Entrar a Phygitalia
          </Link>
        </footer>
      </article>
    </main>
  );
}

/**
 * Revalida un `href` de perfil (C-1). Sólo devuelve http/https; cualquier otro
 * esquema (javascript:, data:, vbscript:, …) o URL inválida → null (no se
 * renderiza). Si no trae esquema, asume https:// (mismo criterio que profile.ts).
 */
function safeHref(raw: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  try {
    const proto = new URL(candidate).protocol.toLowerCase();
    return proto === "http:" || proto === "https:" ? candidate : null;
  } catch {
    return null;
  }
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
