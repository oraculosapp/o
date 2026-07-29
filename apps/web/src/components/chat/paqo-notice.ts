/**
 * Copy del aviso LOCAL y efímero que `OpenChannel` muestra cuando una mención a
 * Paqo ("@paqo") en el canal abierto NO obtiene respuesta (cooldown/límite/red).
 * Antes `useBiosphere` disparaba `mentionPaqoPublic` con `void …` y tragaba el
 * desenlace: si tocabas el cooldown de 10 s, tu mención simplemente se quedaba
 * sin respuesta y Paqo "te ignoraba" sin ninguna pista. Ahora el desenlace
 * (`MentionPaqoOutcome`, ver `lib/oracle-client.ts`) llega hasta aquí y este mapa
 * lo convierte en una frase corta, en la voz de la casa — SOLO la ve quien
 * mencionó a Paqo (no se difunde al canal).
 *
 * Extraído como función pura para poder testearlo sin montar React/DOM (los
 * tests del repo corren en entorno `node`, sin jsdom).
 */
export type PaqoNoticeReason = "cooldown" | "rate-limited" | "unavailable" | "network";

const COPY: Record<PaqoNoticeReason, string> = {
  cooldown: "Paqo está recuperando el aliento… inténtalo en unos segundos.",
  "rate-limited": "Paqo necesita una pausa. Dale un momento.",
  unavailable: "Paqo anda perdido por ahora. Inténtalo de nuevo enseguida.",
  network: "Paqo no alcanzó a oírte (la red se cortó). Reintenta.",
};

/** Traduce el motivo del desenlace a la frase que ve el viajero. */
export function paqoNoticeCopy(reason: PaqoNoticeReason): string {
  return COPY[reason];
}
