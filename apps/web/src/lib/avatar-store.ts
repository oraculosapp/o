/**
 * Selección de avatar del viajero (S8, dirección "nube"): persistencia
 * (localStorage + jsonb del perfil) y utilidades para el mundo/presencia.
 *
 * El avatar es ÚNICO ("nube", plastilina neutra) y la personalización es SÓLO el
 * color: la selección se reduce a `{ color }` (+ el nombre, que vive en
 * `phy:displayName` — lib/oracle-client — y se cambia desde el chat).
 *
 * Contrato con el mundo (PaqoWorld.setAvatar):
 *   { archetypeUrl: "/assets/avatars/gen/nube.glb", tint: { primary: color } }
 * El GLB trae materiales "body" (→ zona primary, se tinta) y "eyes" (negro).
 *
 * La selección se guarda en:
 *   · localStorage `phy:avatar` (siempre, también anónimos).
 *   · `phy:tint` (el color) — la clave que ya usa la presencia del chat
 *     (lib/oracle-client), para que los demás te vean con tu color.
 *   · columna `avatar` (jsonb) del perfil, sólo si el usuario está registrado.
 *
 * COMPAT: los formatos viejos en localStorage/perfil (S7: `{ archetype, build,
 * tint }`) se NORMALIZAN a "nube": se conserva su color primario si era un color
 * real (no blanco-fábrica) y, si no, se asigna un color pastel aleatorio.
 */
import { NUBE_ID, nubeGlbUrl } from "./avatars";
import { randomColor } from "./names";
import { getSupabaseBrowserClient } from "./supabase";

/** Selección de avatar del viajero: el diseño es fijo ("nube"), sólo hay color. */
export interface AvatarSelection {
  /** Color del cuerpo (hex `#rrggbb`), de la paleta pastel o el picker libre. */
  color: string;
}

/** Config serializable que se pasa a PaqoWorld (hex, no THREE). */
export interface AvatarWorldConfig {
  /** URL del GLB del avatar nube (el mundo lo carga con `loadAvatarRigShared`). */
  archetypeUrl: string;
  tint: { primary: string };
}

const KEY = "phy:avatar";
const TINT_KEY = "phy:tint"; // compartida con la presencia (oracle-client)

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** Blanco = "fábrica" del formato viejo (no era un color elegido). */
const WHITE = "#ffffff";

/** Selección por defecto: color pastel aleatorio (primer ingreso sin fricción). */
export function defaultSelection(): AvatarSelection {
  return { color: randomColor() };
}

/**
 * Normaliza un objeto arbitrario (localStorage/jsonb) a una selección válida.
 * Acepta:
 *   · formato NUEVO `{ color }` (con o sin `design`),
 *   · formato VIEJO S7 `{ archetype, build?, tint? }` → conserva `tint.primary`
 *     si era un color real (≠ blanco-fábrica); si no, color aleatorio.
 * Devuelve `null` sólo si `raw` no se parece a ninguna selección.
 */
export function normalizeSelection(raw: unknown): AvatarSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Formato nuevo: { color } (design opcional, siempre "nube").
  if (typeof r.color === "string" && HEX_RE.test(r.color)) {
    return { color: r.color.toLowerCase() };
  }

  // Formato viejo S7: { archetype, build?, tint? } → normaliza a nube.
  if (typeof r.archetype === "string") {
    const t = (r.tint && typeof r.tint === "object" ? r.tint : {}) as Record<string, unknown>;
    const primary = typeof t.primary === "string" && HEX_RE.test(t.primary) ? t.primary.toLowerCase() : null;
    // Blanco era "sin tinte" (colores de fábrica del arquetipo): no es un color
    // elegido → color pastel aleatorio. Un color real se respeta.
    return { color: primary && primary !== WHITE ? primary : randomColor() };
  }

  return null;
}

/** Lee la selección de localStorage (o null si no hay/está corrupta). */
export function getStoredAvatar(): AvatarSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? normalizeSelection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Persiste la selección en localStorage + sincroniza `phy:tint` (presencia). */
export function storeAvatar(sel: AvatarSelection): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ design: NUBE_ID, color: sel.color }));
    window.localStorage.setItem(TINT_KEY, sel.color);
  } catch {
    /* cuota llena / modo privado: no es crítico */
  }
}

/** Config del mundo derivada de una selección: el GLB nube + su color. */
export function worldConfigFromSelection(sel: AvatarSelection): AvatarWorldConfig {
  return {
    archetypeUrl: nubeGlbUrl(),
    tint: { primary: sel.color },
  };
}

/**
 * Id de avatar que transmite la presencia (para que los remotos carguen el MISMO
 * diseño). Con el diseño único siempre es `"nube"`.
 */
export function getStoredArchetype(): string | undefined {
  return NUBE_ID;
}

/** Color almacenado (o undefined) — lo usa la presencia como `tint`. */
export function getStoredPrimaryTint(): string | undefined {
  return getStoredAvatar()?.color;
}

/** Guarda la selección en el perfil (jsonb `avatar`) si el usuario está registrado. */
export async function saveAvatarToProfile(sel: AvatarSelection): Promise<void> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user || user.is_anonymous) return; // anónimo: sólo localStorage
    await supabase
      .from("profiles")
      .update({ avatar: { design: NUBE_ID, color: sel.color } })
      .eq("id", user.id);
  } catch (err) {
    console.warn("[avatar] no se pudo guardar el avatar en el perfil:", err);
  }
}

/** Carga la selección del perfil (jsonb `avatar`) — null si no hay/no aplica. */
export async function loadAvatarFromProfile(): Promise<AvatarSelection | null> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data } = await supabase.from("profiles").select("avatar").maybeSingle();
    return normalizeSelection(data?.avatar);
  } catch {
    return null;
  }
}
