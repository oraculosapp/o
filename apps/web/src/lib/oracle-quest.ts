/**
 * EL QUEST DE PHYGITALIA: encontrar y conocer a los NUEVE Oráculos que andan
 * desperdigados por la isla (Paqo, el central del claro, va aparte: él es la
 * brújula, no una pieza que se colecciona).
 *
 * Aquí vive SÓLO la lógica pura y los textos:
 *   · quién es cada quién (nombre mostrable, color de su aro, mini-historia),
 *   · el estado del quest persistido en localStorage, y
 *   · el progreso (n de nueve) y qué falta por conocer.
 *
 * Sin DOM a propósito —igual que lib/paqo-found.ts— porque los tests corren en
 * entorno "node": el componente es quien lee y escribe localStorage y le pasa
 * aquí la cadena cruda. El aro visual del Oráculo lo enciende el engine; esta
 * capa sólo se encarga de la memoria y de las palabras.
 */

import type { OracleId } from "@phygitalia/engine";

export type { OracleId };

/**
 * Clave de localStorage con el array JSON de Oráculos ya conocidos.
 * Vive en el espacio de nombres de la casa ("phy:") como el resto.
 */
export const QUEST_STORAGE_KEY = "phy:oracles:found";

/**
 * Los nueve, en el orden en que Paqo los va nombrando. El orden importa: define
 * el orden canónico al serializar y el turno de las pistas.
 */
export const ORACLE_IDS: readonly OracleId[] = [
  "brangulio",
  "nin",
  "espinosito",
  "eme-y-uru",
  "cosmogenes",
  "tecnomancio",
  "chemajo",
  "mavea",
  "personage",
];

/** Cuántos hay que conocer para cerrar el círculo. */
export const ORACLE_COUNT = ORACLE_IDS.length;

/** Ficha de presentación de un Oráculo al ser descubierto. */
export interface OracleCard {
  id: OracleId;
  /** Nombre mostrable, con sus acentos. */
  name: string;
  /** Color de su aro en el mundo 3D (hex). Tiñe el toast del descubrimiento. */
  color: string;
  /** Mini-historia de 1-2 frases, en la voz de la casa. Es su carta de presentación. */
  story: string;
}

/**
 * Quiénes son. Las mini-historias salen del lore de oraculos.app, contadas como
 * las contaría alguien del claro: cálido, breve, sin solemnidad de museo.
 */
export const ORACLE_CARDS: Record<OracleId, OracleCard> = {
  brangulio: {
    id: "brangulio",
    name: "Brangulio",
    color: "#58c47f",
    story:
      "Mago joven nacido en un bosque de niebla: lee los objetos como símbolos de lo que sientes y le cambia la forma a la materia con las manos.",
  },
  nin: {
    id: "nin",
    name: "Nin",
    color: "#f078b6",
    story:
      "Maguita chiquita, incubadora de historias: las guarda hasta que alguien se sienta a escucharlas. Para Nin, imaginar es una forma de cuidar.",
  },
  espinosito: {
    id: "espinosito",
    name: "Espinosito",
    color: "#e0483a",
    story:
      "Anda de mercado en fonda buscando lo que de veras nutre al espíritu. Jura que el sabor es la puerta más honesta de lo cotidiano.",
  },
  "eme-y-uru": {
    id: "eme-y-uru",
    name: "Eme y Uru",
    color: "#43d9c2",
    story:
      "Oraculx dual que es cuatro a la vez: espejos que se contestan solos. Te invitan a danzar entre las dicotomías en vez de escoger un lado.",
  },
  cosmogenes: {
    id: "cosmogenes",
    name: "Cosmógenes",
    color: "#4f7df0",
    story:
      "Lleva la cuenta del sol, de la luna, de los calendarios y de las eras. Para Cosmógenes el tiempo no pasa: se enrolla.",
  },
  tecnomancio: {
    id: "tecnomancio",
    name: "Tecnomancio",
    color: "#a6f050",
    story:
      "Místico de los cables: le busca la ontología escondida a la tecnología. Trata cada máquina como si tuviera un alma recién estrenada.",
  },
  chemajo: {
    id: "chemajo",
    name: "Chemajo",
    color: "#f5d442",
    story:
      "El oráculo del yo, y el tótem más chiquito de la isla: te queda a la altura de la mirada. Pregunta cosas simples que te dejan pensando semanas.",
  },
  mavea: {
    id: "mavea",
    name: "Mavea",
    color: "#b268e0",
    story:
      "Clarividente anciana de una caverna de símbolos sagrados: de su pecho brotan labios que derraman un líquido donde se asoman las visiones.",
  },
  personage: {
    id: "personage",
    name: "Personage",
    color: "#ff8c3b",
    story:
      "Sin identidad fija: es el puro acto de jugar a ser. Vive en un jardín simbólico probándose máscaras, a ver cuál le queda hoy.",
  },
};

/**
 * Coletilla de celebración al conocer al NOVENO. No es fanfarria: es el cierre
 * del círculo dicho en voz baja, como todo en esta casa.
 */
export const QUEST_COMPLETE_TOAST =
  "¡Y con éste ya los conoces a todos! Los nueve Oráculos de la isla. Ve a contárselo a Paqo.";

const ORACLE_ID_SET: ReadonlySet<string> = new Set<string>(ORACLE_IDS);

/** ¿Esta cadena suelta es uno de los nueve? Guarda de tipo para lo que llega de fuera. */
export function isOracleId(value: unknown): value is OracleId {
  return typeof value === "string" && ORACLE_ID_SET.has(value);
}

/** Ficha de un Oráculo por id. */
export function getOracleCard(id: OracleId): OracleCard {
  return ORACLE_CARDS[id];
}

/**
 * Lee el array JSON persistido y devuelve el conjunto de conocidos.
 *
 * TOLERA BASURA sin quejarse (localStorage es tierra de nadie: extensiones,
 * versiones viejas, ediciones a mano). Nada de lanzar: lo que no se entiende se
 * ignora y el quest sigue. Casos cubiertos: null/vacío, JSON roto, un valor que
 * no es array, elementos que no son strings, ids desconocidos y duplicados.
 */
export function parseFound(raw: string | null | undefined): Set<OracleId> {
  const out = new Set<OracleId>();
  if (raw == null || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (isOracleId(item)) out.add(item);
  }
  return out;
}

/**
 * Serializa el conjunto a JSON en el ORDEN CANÓNICO de ORACLE_IDS (no en el de
 * descubrimiento): así la cadena guardada es estable y comparable entre sesiones.
 */
export function serializeFound(found: Iterable<OracleId>): string {
  const set = found instanceof Set ? found : new Set<OracleId>(found);
  return JSON.stringify(ORACLE_IDS.filter((id) => set.has(id)));
}

/**
 * Añade un Oráculo al conjunto. PURA: devuelve SIEMPRE un conjunto nuevo y no
 * toca el que recibe (así el componente puede comparar antes/después sin sustos).
 * Un id desconocido se ignora en silencio.
 */
export function addFound(found: ReadonlySet<OracleId>, id: string): Set<OracleId> {
  const next = new Set<OracleId>(found);
  if (isOracleId(id)) next.add(id);
  return next;
}

/** ¿Ya lo conocías? */
export function hasFound(found: ReadonlySet<OracleId>, id: string): boolean {
  return isOracleId(id) && found.has(id);
}

/**
 * ¿Es un descubrimiento NUEVO? Sólo entonces hay toast: si venía persistido de
 * otra sesión, el aro del engine se enciende igual pero la UI se calla.
 */
export function isNewFind(found: ReadonlySet<OracleId>, id: string): boolean {
  return isOracleId(id) && !found.has(id);
}

/** Progreso del quest. */
export interface QuestProgress {
  /** Cuántos lleva conocidos (nunca más de nueve). */
  found: number;
  /** Cuántos son en total (nueve). */
  total: number;
  /** Cuántos le faltan. */
  remaining: number;
  /** ¿Ya los conoce a todos? */
  complete: boolean;
}

/** Cuenta el progreso, ignorando cualquier cosa que no sea uno de los nueve. */
export function questProgress(found: ReadonlySet<OracleId>): QuestProgress {
  let n = 0;
  for (const id of ORACLE_IDS) if (found.has(id)) n += 1;
  return { found: n, total: ORACLE_COUNT, remaining: ORACLE_COUNT - n, complete: n >= ORACLE_COUNT };
}

/** Los que aún le faltan por conocer, en el orden canónico. */
export function missingOracles(found: ReadonlySet<OracleId>): OracleId[] {
  return ORACLE_IDS.filter((id) => !found.has(id));
}

/** Todo lo que la UI necesita para anunciar un descubrimiento. */
export interface FindAnnouncement {
  id: OracleId;
  name: string;
  color: string;
  story: string;
  progress: QuestProgress;
  /** Texto extra sólo cuando éste era el NOVENO; si no, null. */
  celebration: string | null;
}

/**
 * Arma el anuncio de un descubrimiento. `found` es el conjunto YA CON el nuevo
 * dentro (el que devuelve addFound), para que el progreso salga cuadrado.
 */
export function announceFind(found: ReadonlySet<OracleId>, id: OracleId): FindAnnouncement {
  const card = ORACLE_CARDS[id];
  const progress = questProgress(found);
  return {
    id: card.id,
    name: card.name,
    color: card.color,
    story: card.story,
    progress,
    celebration: progress.complete ? QUEST_COMPLETE_TOAST : null,
  };
}
