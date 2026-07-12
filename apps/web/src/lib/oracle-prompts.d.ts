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

  /**
   * Ficha del Oráculo (subconjunto que consume la UI Social). El paquete real
   * expone más campos; aquí sólo declaramos lo que usa apps/web, para mantener
   * la web desacoplada del grafo de tipos completo de @phygitalia/content.
   */
  export interface OracleDefinition {
    id: string;
    name: string;
    color: string;
    systemPrompt: string;
    publicGreeting: string;
    /** Pistas susurradas escalonadas (HUD de pistas). */
    hints: string[];
  }

  /** Resuelve la ficha completa de un Oráculo por id (lanza si no existe). */
  export function getOracle(id: string): OracleDefinition;

  /**
   * Lista todos los Oráculos con voz escrita (en orden de prioridad). La
   * Plataforma la usa como LISTA BLANCA de oracleId válidos en `/api/oracle`
   * (validate.ts, fix de seguridad A-1).
   */
  export function listOracles(): OracleDefinition[];
}
