/**
 * Cooldown en memoria por clave (p.ej. por canal de Biósfera).
 *
 * Se usa para acotar cuántas veces responde un Oráculo en el CHAT PÚBLICO: como
 * cada respuesta pública se inserta en `biosphere_messages` (is_oracle = true) y
 * la ve TODO el canal por Realtime, sin cooldown una ráfaga de menciones "@paqo"
 * inundaría el chat (y quemaría cuota de OpenAI).
 *
 * ⚠️ LIMITACIÓN SERVERLESS: igual que el rate-limit, el estado vive en la
 * instancia (proceso) actual. En Vercel con varias instancias no es una cuota
 * global — es un guardarraíl best-effort. Para algo duro habría que mover el
 * timestamp a Postgres/Upstash (fuera del alcance de la beta).
 */

export interface Cooldown {
  /**
   * Intenta adquirir el turno para `key`. Devuelve `true` si NO estaba en
   * cooldown (y registra el instante); `false` si aún está dentro de la ventana.
   */
  tryAcquire(key: string): boolean;
}

export interface CooldownOptions {
  /** Tamaño de la ventana en ms (p.ej. 10_000 = 1 respuesta / 10 s). */
  windowMs: number;
  /** Máx. claves retenidas (protección de memoria). */
  maxKeys?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

export function createCooldown(opts: CooldownOptions): Cooldown {
  const { windowMs, maxKeys = 1_000, now = Date.now } = opts;
  const last = new Map<string, number>();

  return {
    tryAcquire(key: string): boolean {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < windowMs) return false;

      // Poda perezosa de claves expiradas + tapa de tamaño.
      if (last.size > maxKeys) {
        for (const [k, ts] of last) {
          if (t - ts >= windowMs) last.delete(k);
        }
      }
      last.set(key, t);
      return true;
    },
  };
}
