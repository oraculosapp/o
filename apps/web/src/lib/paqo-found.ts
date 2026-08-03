/**
 * PAQO, BRÚJULA DEL QUEST (señal "found" de world.net.onZoneSignal).
 *
 * Cuando el viajero llega al claro, Paqo ya no dice "ya llegaste conmigo": eso
 * se ve solo. Lo que hace es lo suyo —guiar—: saluda cortito, le recuerda cómo
 * va el quest de los NUEVE Oráculos desperdigados por la isla, y le suelta UNA
 * pista atmosférica hacia alguno que todavía no conoce. Nunca da coordenadas:
 * Paqo señala con el olfato, no con el dedo.
 *
 * El engine ya pone lo sonoro (acorde-campana ceremonial + ráfaga de chispas del
 * bed). Aquí vive SÓLO la lógica pura de la celebración VISUAL que añade la UI:
 *   · cuándo celebrar (una vez por sesión + cooldown por visita), y
 *   · qué dice Paqo (determinista por semilla, sin repetir la pista anterior).
 *
 * Es lógica pura y sin DOM a propósito (los tests corren en entorno "node"): el
 * componente le pasa el `now`, el último instante leído de localStorage y el
 * conjunto de Oráculos ya conocidos (ver lib/oracle-quest.ts).
 */

import {
  ORACLE_CARDS,
  ORACLE_COUNT,
  missingOracles,
  questProgress,
  type OracleId,
} from "./oracle-quest";

/**
 * Cooldown por VISITA: si el viajero entra y sale del claro (o recarga la página)
 * dentro de esta ventana, la celebración NO se repite. Dos minutos es el punto
 * donde la ceremonia sigue sintiéndose ganada sin volverse ruido de fondo.
 */
export const FOUND_COOLDOWN_MS = 120_000;

/**
 * Clave de localStorage con el instante (ms epoch) de la última celebración.
 * Se persiste — y no sólo se guarda en memoria — porque el engine reinicia su
 * `foundFired` en cada carga de página: sin persistir, recargar dentro del claro
 * dispararía la ceremonia otra vez.
 */
export const FOUND_STORAGE_KEY = "phy:paqo:found-at";

/**
 * Saludo de entrada: cálido, coloquial mexicano, brevísimo. Es la carraspera
 * antes de la pista, no el plato fuerte — por eso no pasa de una línea.
 */
export const PAQO_GREETINGS: readonly string[] = [
  "Órale, viajero: el tercer ojo ya te había visto venir.",
  "¿Qué onda, viajero? Aquí sigo, barro y dato.",
  "Qué bueno que te asomas al claro, viajero.",
  "Ándale, viajero, justo te andaba esperando.",
];

/**
 * LAS NUEVE PISTAS, en voz de Paqo. Son atmosféricas a propósito: un olor, un
 * ruido, una altura. Nada de coordenadas ni de "al norte del árbol grande" —
 * la gracia del quest es deambular, no seguir un GPS.
 */
export const PAQO_QUEST_HINTS: Record<OracleId, string> = {
  brangulio:
    "Donde la niebla se enreda entre los árboles anda un mago joven que le cambia la forma a las cosas.",
  nin: "Escucha bajito: hay una maguita que guarda historias y sólo las suelta a quien se sienta a oírlas.",
  espinosito: "Uno de ellos anda con hambre de espíritu: síguele el olor a fonda y lo hallas.",
  "eme-y-uru": "Hay quien es dos y también cuatro. Búscalos donde algo se refleje y te conteste.",
  cosmogenes:
    "Alguien lleva la cuenta del sol y de la luna: camina hacia donde el cielo se sienta más ancho.",
  tecnomancio:
    "Si oyes zumbar algo que no es insecto, por ahí anda el que le busca alma a las máquinas.",
  chemajo:
    "Aguas, viajero: el que pregunta quién eres es el tótem más chiquito. Baja la mirada o te lo pasas de largo.",
  mavea: "Busca la caverna de la que llora visiones; ahí adentro te espera una anciana que ve por el pecho.",
  personage:
    "Hay un jardín de máscaras. El de allí no tiene cara fija, sólo ganas de jugar a ser alguien.",
};

/**
 * Cierre del quest: los nueve conocidos. Sigue siendo susurro, no fanfarria,
 * pero con el gusto de quien te presentó a toda su banda.
 */
export const PAQO_QUEST_COMPLETE: readonly string[] = [
  "Ya los conoces a los nueve, viajero. Cerraste el círculo: esta isla ya es tuya.",
  "Nueve de nueve. Ahora ellos también te conocen a ti, y eso no se deshace.",
  "Los nueve en tu memoria, viajero. Vuelve con quien quieras: aquí seguimos.",
];

/** Lee el instante persistido; tolera basura, vacíos y valores fuera de rango. */
export function parseLastFoundAt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * ¿Toca celebrar? Sí si nunca se celebró, o si la última fue hace más que el
 * cooldown. Un `lastAt` en el FUTURO (reloj movido, husos) se trata como reciente:
 * preferimos callar de más antes que repetir la ceremonia.
 */
export function shouldCelebrateFound(
  lastAt: number | null | undefined,
  now: number,
  cooldownMs: number = FOUND_COOLDOWN_MS
): boolean {
  if (lastAt == null) return true;
  if (!Number.isFinite(lastAt)) return true;
  const elapsed = now - lastAt;
  if (elapsed < 0) return false; // reloj hacia atrás: no repetimos
  return elapsed >= cooldownMs;
}

/**
 * Elige una variante a partir de una semilla (p.ej. `Date.now()`).
 * Determinista para la misma semilla y, si puede, EVITA repetir la anterior.
 */
export function pickVariant(
  seed: number,
  previous?: string | null,
  variants: readonly string[] = PAQO_GREETINGS
): string {
  if (variants.length === 0) return "";
  const safe = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  let i = safe % variants.length;
  if (variants.length > 1 && previous != null && variants[i] === previous) {
    i = (i + 1) % variants.length;
  }
  return variants[i];
}

/**
 * Cómo cuenta Paqo el progreso. En palabras, no en marcador: "uno de los nueve"
 * suena a persona; "1/9" suena a videojuego de otro barrio.
 */
export function progressPhrase(foundCount: number): string {
  const n = Math.max(0, Math.min(ORACLE_COUNT, Math.trunc(foundCount) || 0));
  if (n === 0) return `Todavía no encuentras a ninguno de los ${ORACLE_COUNT} Oráculos.`;
  if (n === 1) return `Llevas uno de los ${ORACLE_COUNT}.`;
  return `Has encontrado ${n} de los ${ORACLE_COUNT}.`;
}

/** Lo que Paqo dice al ser encontrado, ya armado, y a quién apuntó. */
export interface PaqoGuideMessage {
  /** El mensaje completo, listo para la píldora. */
  text: string;
  /** El Oráculo al que mandó esta vez (null si ya están todos). */
  hintFor: OracleId | null;
  /** ¿Es el mensaje de quest completo? */
  complete: boolean;
}

/**
 * EL MENSAJE-GUÍA de Paqo: saludo + progreso + una pista hacia UNO que falte.
 *
 * Determinista por semilla (misma semilla, mismo mensaje) y, cuando queda más de
 * uno por conocer, NO repite el Oráculo de la pista anterior: Paqo no es un loro,
 * si ya te mandó con Mavea y volviste, ahora te manda con otro.
 *
 * Con los nueve conocidos devuelve la celebración de cierre y `hintFor: null`.
 */
export function pickGuideMessage(
  found: ReadonlySet<OracleId>,
  seed: number,
  previousHintFor?: OracleId | null
): PaqoGuideMessage {
  const progress = questProgress(found);
  const missing = missingOracles(found);

  if (progress.complete || missing.length === 0) {
    return {
      text: pickVariant(seed, null, PAQO_QUEST_COMPLETE),
      hintFor: null,
      complete: true,
    };
  }

  const safe = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  let i = safe % missing.length;
  if (missing.length > 1 && previousHintFor != null && missing[i] === previousHintFor) {
    i = (i + 1) % missing.length;
  }
  const target = missing[i];

  const greeting = pickVariant(seed, null, PAQO_GREETINGS);
  const text = `${greeting} ${progressPhrase(progress.found)} ${PAQO_QUEST_HINTS[target]}`;

  return { text, hintFor: target, complete: false };
}

/** Nombre mostrable del Oráculo de una pista (para el toast, si hace falta). */
export function hintTargetName(id: OracleId): string {
  return ORACLE_CARDS[id].name;
}
