/**
 * Runas de las Biósferas para la sección "Tu viaje" del perfil.
 *
 * Orden y nombres de las 6 prioritarias de la beta (PLAN-MAESTRO §2/§6). En la
 * beta sólo Paqo es jugable: se ilumina según `progress` (encontrada/desbloqueada);
 * el resto se muestran opacas con "Próximamente".
 */
export interface BiosphereRune {
  id: string;
  name: string;
}

export const BIOSPHERE_RUNES: BiosphereRune[] = [
  { id: "paqo", name: "Paqo" },
  { id: "cosmogenes", name: "Cosmógenes" },
  { id: "nin", name: "Nin" },
  { id: "brangulio", name: "Brangulio" },
  { id: "espinosito", name: "Espinosito" },
  { id: "eme-y-uru", name: "Eme y Uru" },
];
