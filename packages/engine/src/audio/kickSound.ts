/**
 * SEPARACIÓN dato↔sonido del canal de patadas de pelota.
 *
 * El canal `kickCbs` de Balls está MULTIPLEXADO: además de las patadas y
 * lanzamientos reales, difunde a ~10 Hz el estado del balón AGARRADO y el snap
 * de cada respawn — puro tráfico de red para que los remotos reconcilien. Esas
 * emisiones llevan SIEMPRE velocidad horizontal nula (el balón va pegado a la
 * mano o acaba de reaparecer quieto), mientras que una patada real garantiza un
 * impulso mínimo (KICK_MIN = 2 u/s) y un lanzamiento sale a THROW_SPEED (9.5).
 *
 * Este helper decide la fuerza AUDIBLE (0..1) de una emisión: 0 significa "es
 * dato, no sonido — no dispares foley". Sin este corte, el portador oía una
 * ametralladora de pops a 10 Hz (y una campana continua si llevaba la dorada)
 * que el delay del foley embarraba en una reverberación horrible, y cada
 * respawn sonaba como patada fantasma.
 *
 * Es una función PURA (testeable en node, sin WebAudio): la usa PaqoWorld al
 * suscribir el audio a `onBallKick`.
 */

/**
 * Velocidad horizontal (u/s) que separa dato (≈0: balón en mano / respawn) de
 * patada real (≥ KICK_MIN = 2). El margen tolera ruido numérico sin comerse
 * ninguna patada legítima.
 */
export const MIN_AUDIBLE_KICK_SPEED = 0.5;

/** Velocidad (u/s) que mapea a fuerza 1 (patadón a la carrera / lanzamiento). */
const FULL_KICK_SPEED = 8;

/** Fuerza audible 0..1 de una emisión de patada según la velocidad difundida. */
export function kickStrengthFromVel(vel: readonly [number, number, number]): number {
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed < MIN_AUDIBLE_KICK_SPEED) return 0; // dato de red (mano/respawn): silencio
  return Math.min(1, speed / FULL_KICK_SPEED);
}
