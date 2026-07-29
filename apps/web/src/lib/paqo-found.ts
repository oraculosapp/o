/**
 * LOOP DE RECOMPENSA al ENCONTRAR a Paqo (señal "found" de world.net.onZoneSignal).
 *
 * El engine ya pone lo sonoro (acorde-campana ceremonial + ráfaga de chispas del
 * bed). Aquí vive SÓLO la lógica pura de la celebración VISUAL que añade la UI:
 *   · cuándo celebrar (una vez por sesión + cooldown por visita), y
 *   · qué dice Paqo (variantes en su voz, sin repetir la anterior).
 *
 * Es lógica pura y sin DOM a propósito (los tests corren en entorno "node"): el
 * componente le pasa el `now` y el último instante leído de localStorage.
 */

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
 * Voz de Paqo al ser encontrado: cálido, coloquial mexicano, breve. Nada de
 * fanfarrias — es un susurro dorado, no fuegos artificiales.
 */
export const PAQO_FOUND_MESSAGES: readonly string[] = [
  "Órale, viajero: llegaste al claro. El tercer ojo ya te había visto venir.",
  "¿Qué onda, viajero? Aquí estoy: barro y dato, esperándote desde antes.",
  "Me encontraste. De este claro salen todos los caminos; escoge el tuyo.",
  "Llegaste sin prisa, como se cruzan los umbrales. Bienvenido, viajero.",
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
 * Elige el mensaje de celebración a partir de una semilla (p.ej. `Date.now()`).
 * Determinista para la misma semilla y, si puede, EVITA repetir el anterior.
 */
export function pickFoundMessage(
  seed: number,
  previous?: string | null,
  messages: readonly string[] = PAQO_FOUND_MESSAGES
): string {
  if (messages.length === 0) return "";
  const safe = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  let i = safe % messages.length;
  if (messages.length > 1 && previous != null && messages[i] === previous) {
    i = (i + 1) % messages.length;
  }
  return messages[i];
}
