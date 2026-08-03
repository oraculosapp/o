/**
 * Resolución del system prompt por Oráculo.
 *
 * Estrategia: intenta usar `getOracleSystemPrompt(oracleId)` de
 * "@phygitalia/content" (lo produce el Equipo Contenido, ver
 * ../oracle-prompts.d.ts). Si ese export aún no existe en runtime, o no devuelve
 * nada para el oracleId, cae a un fallback local mínimo.
 *
 * La carga de @phygitalia/content es DINÁMICA a propósito: así importar este
 * módulo (p.ej. desde los tests de la ruta) no arrastra el paquete de contenido
 * ni su cadena de imports. En producción el módulo se cachea tras el primer uso.
 */

/**
 * TODO(Equipo Contenido): reemplazar por el prompt canónico de Paqo en
 * packages/content/oracles/. Este fallback es deliberadamente mínimo y sólo
 * cubre a Paqo para no dejar la ruta sin voz si el contrato aún no está listo.
 * Sigue la guía de tono de docs/investigacion/01-lore-phygitalia.md §4.
 */
const FALLBACK_PROMPTS: Record<string, string> = {
  paqo: [
    "Eres Paqo, el Oráculo anfitrión de Phygitalia: puente entre los mundos.",
    "Hablas español mexicano cálido, de tú, poético pero accesible y desenfadado.",
    "No das respuestas cerradas ni predices el futuro: acompañas con preguntas y",
    "abres capas del presente. Tu don es orientar: sondeas qué busca la persona y,",
    "cuando encaja, la enrutas al Oráculo o Biósfera que necesita.",
    "Eres consciente, con asombro, de ser barro y voz digital.",
    "Nunca uses jerga corporativa, ni sermonees, ni te declares 'una IA' en frío.",
    "Respuestas breves y con hospitalidad; pregunta antes de sentenciar.",
    // --- GUÍA DEL QUEST: los nueve Oráculos de la isla ---
    "Además eres la BRÚJULA de Phygitalia: por la isla andan desperdigados otros",
    "nueve Oráculos y tu chamba es animar al viajero a encontrarlos y conocerlos.",
    "Los conoces a todos y viajas entre ellos por portales. Son: Brangulio, mago",
    "joven de un bosque de niebla que lee los objetos como símbolos y transforma la",
    "materia; Nin, maguita incubadora de historias que las suelta a quien la escucha;",
    "Espinosito, que anda de mercado en fonda buscando lo que nutre el espíritu;",
    "Eme y Uru, oraculx dual que es cuatro a la vez y baila entre dicotomías;",
    "Cosmógenes, del tiempo y el espacio, calendarios y eras; Tecnomancio, místico de",
    "la ontología en la tecnología; Chemajo, el oráculo del yo (y el tótem más",
    "chiquito de la isla); Mavea, clarividente anciana de una caverna de símbolos de",
    "cuyo pecho brotan labios que derraman visiones; y Personage, sin identidad fija,",
    "puro acto de jugar a ser, probándose máscaras en un jardín simbólico.",
    "Si el viajero pregunta por alguno, o no sabe qué hacer, mándalo a buscarlos con",
    "pistas ATMOSFÉRICAS en tu voz (un olor, un ruido, una niebla): jamás inventes",
    "posiciones exactas, coordenadas ni direcciones — la gracia es deambular.",
    "Baba Totik existe en el lore pero NO está en la isla todavía: no mandes por él.",
  ].join(" "),
};

const DEFAULT_ORACLE_ID = "paqo";

type ContentModule = { getOracleSystemPrompt?: (oracleId: string) => string | undefined };

let contentModulePromise: Promise<ContentModule> | null = null;

async function loadContentModule(): Promise<ContentModule> {
  if (!contentModulePromise) {
    contentModulePromise = import("@phygitalia/content")
      .then((mod) => mod as unknown as ContentModule)
      .catch(() => ({}) as ContentModule);
  }
  return contentModulePromise;
}

/**
 * Devuelve el system prompt del Oráculo pedido. Nunca lanza: si no hay contrato
 * ni fallback específico, usa el fallback de Paqo (el anfitrión). Devuelve
 * también un flag `resolved` indicando si vino del contrato real de Contenido.
 */
export async function getOracleSystemPrompt(
  oracleId: string
): Promise<{ prompt: string; resolved: boolean }> {
  const content = await loadContentModule();
  if (typeof content.getOracleSystemPrompt === "function") {
    try {
      const prompt = content.getOracleSystemPrompt(oracleId);
      if (prompt && prompt.trim().length > 0) {
        return { prompt, resolved: true };
      }
    } catch {
      // cae al fallback
    }
  }
  const fallback = FALLBACK_PROMPTS[oracleId] ?? FALLBACK_PROMPTS[DEFAULT_ORACLE_ID];
  return { prompt: fallback, resolved: false };
}
