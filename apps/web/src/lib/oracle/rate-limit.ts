/**
 * Rate-limit simple en memoria (ventana deslizante por clave).
 *
 * ⚠️ LIMITACIÓN SERVERLESS: el estado vive en la instancia (proceso) actual. En
 * Vercel/edge con varias instancias o arranques en frío, el conteo NO es global
 * — es un guardarraíl best-effort contra ráfagas por instancia, no una cuota
 * dura. Para una cuota real se necesitaría un backend compartido (Upstash/Redis
 * o una tabla en Postgres), fuera del alcance de la beta.
 *
 * Se acota la memoria con una tapa de claves (LRU aproximado por poda).
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Segundos sugeridos para Retry-After cuando allowed = false. */
  retryAfter: number;
  remaining: number;
}

export interface RateLimiterOptions {
  /** Máx. peticiones permitidas por ventana. */
  limit: number;
  /** Tamaño de la ventana en ms. */
  windowMs: number;
  /** Máx. claves distintas retenidas (protección de memoria). */
  maxKeys?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

interface Bucket {
  /** Timestamps (ms) de las peticiones dentro de la ventana. */
  hits: number[];
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, maxKeys = 5_000, now = Date.now } = opts;
  const buckets = new Map<string, Bucket>();

  function prune(cutoff: number) {
    // Poda de claves cuyas ventanas ya expiraron; y tapa dura de tamaño.
    for (const [key, bucket] of buckets) {
      const fresh = bucket.hits.filter((t) => t > cutoff);
      if (fresh.length === 0) buckets.delete(key);
      else bucket.hits = fresh;
    }
    if (buckets.size > maxKeys) {
      // Elimina las más antiguas (Map conserva orden de inserción).
      const excess = buckets.size - maxKeys;
      let i = 0;
      for (const key of buckets.keys()) {
        if (i++ >= excess) break;
        buckets.delete(key);
      }
    }
  }

  return {
    check(key: string): RateLimitResult {
      const t = now();
      const cutoff = t - windowMs;
      // Poda barata sólo cuando el mapa crece.
      if (buckets.size > maxKeys) prune(cutoff);

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { hits: [] };
        buckets.set(key, bucket);
      }
      bucket.hits = bucket.hits.filter((ts) => ts > cutoff);

      if (bucket.hits.length >= limit) {
        const oldest = bucket.hits[0];
        const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
        return { allowed: false, retryAfter, remaining: 0 };
      }

      bucket.hits.push(t);
      return { allowed: true, retryAfter: 0, remaining: Math.max(0, limit - bucket.hits.length) };
    },
  };
}
