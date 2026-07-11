/**
 * CONTRATO de consumo de system prompts de Oráculos.
 * ---------------------------------------------------------------------------
 * El Equipo Contenido produce los system prompts en `packages/content`
 * (namespace @phygitalia/content) — por la guía de tono de
 * docs/investigacion/01-lore-phygitalia.md §4. Este archivo declara la interfaz
 * que la Plataforma (S3) espera consumir, para que ambos equipos puedan avanzar
 * en paralelo.
 *
 * Cuando Contenido implemente `getOracleSystemPrompt`, esta declaración le da
 * tipos sin tocar su paquete. Mientras no exista en runtime,
 * `src/lib/oracle/prompts.ts` cae a un fallback local mínimo (ver TODO allí).
 *
 * Firma esperada:
 *   getOracleSystemPrompt(oracleId: string): string | undefined
 *     · Devuelve el system prompt completo del Oráculo (ya con la guía de tono).
 *     · Devuelve `undefined` si el oracleId no existe (la Plataforma decide el
 *       fallback / error).
 *     · NUNCA debe concatenar entrada del usuario (eso lo garantiza la ruta).
 */
declare module "@phygitalia/content" {
  export function getOracleSystemPrompt(oracleId: string): string | undefined;
}
