/**
 * names.ts — Identidad aleatoria del viajero (S8, dirección "nube").
 *
 * El avatar es un único diseño neutro ("nube") y la personalización es SÓLO el
 * color; al primer ingreso se asigna un NOMBRE y un COLOR aleatorios y se entra
 * sin fricción (el nombre se puede cambiar después desde el chat — nameChip).
 *
 * · NAMES: ≥120 nombres neutros INVENTADOS, con el sabor fonético juguetón de la
 *   referencia (Drumbli, Bambu, Coponi, Perenoie, Acatombe, Semblix, Ocotoy,
 *   Mambu, Jojonopi): sílabas suaves, terminaciones -i / -u / -e / -ix / -oy.
 * · PASTEL_COLORS: paleta pastel-plastilina (~16 colores tipo "Not Boring":
 *   azules, verdes, amarillos, corales, lilas, turquesas, cremas), armoniosos
 *   con el mundo flamingo de Paqo.
 */

/** Paleta pastel-plastilina (16 colores). El tinte multiplica el body blanco. */
export const PASTEL_COLORS: readonly string[] = [
  "#9ec7f2", // azul cielo
  "#7fa8e8", // azul lavanda
  "#8fd8c8", // turquesa menta
  "#6fc7b6", // turquesa profundo
  "#a8dba0", // verde manzana
  "#c5e8a5", // verde lima suave
  "#f7e39a", // amarillo mantequilla
  "#f7c873", // amarillo miel
  "#f7a37b", // coral durazno
  "#f2887f", // coral flamingo
  "#f2a8c2", // rosa chicle
  "#e2a8e8", // lila orquídea
  "#b8a5ec", // lila lavanda
  "#efe0c8", // crema vainilla
  "#d8c8b0", // arena tibia
  "#b8ccd8", // gris azulado nube
] as const;

/**
 * ≥120 nombres neutros inventados (sílabas suaves, terminación -i/-u/-e/-ix/-oy).
 * Incluye los 9 de la referencia.
 */
export const NAMES: readonly string[] = [
  // — los de la referencia —
  "Drumbli", "Bambu", "Coponi", "Perenoie", "Acatombe", "Semblix", "Ocotoy", "Mambu", "Jojonopi",
  // — terminación -i —
  "Talori", "Munami", "Bilopi", "Coroni", "Fandeli", "Gomiri", "Halupi", "Jandori",
  "Kilomi", "Lanubi", "Meloti", "Nokari", "Ompali", "Palomi", "Quenili", "Rambuli",
  "Salopi", "Tumbari", "Ulami", "Vindoli", "Wompiri", "Yalumi", "Zandopi", "Birindi",
  "Chalomi", "Dolupi", "Farandi", "Golori", "Hilumi", "Jaropi", "Kandali", "Lomiri",
  // — terminación -u —
  "Andalu", "Bolimu", "Carandu", "Delombu", "Farolu", "Gandumu", "Hilandu", "Jocomu",
  "Kalambu", "Lorimu", "Mandolu", "Nicombu", "Oparu", "Palindu", "Quirambu", "Rondalu",
  "Sacomu", "Tilandu", "Umbolu", "Vandamu", "Wilombu", "Yacaru", "Zolimu", "Bandiru",
  "Chilomu", "Dorandu", "Fambolu", "Golamu",
  // — terminación -e —
  "Anolime", "Baronde", "Calisome", "Dolambe", "Farinole", "Gandome", "Hilarbe", "Jocline",
  "Kalinde", "Lorambe", "Mindole", "Nocarime", "Opalende", "Parolime", "Quirinde", "Rolambe",
  "Salinole", "Tandome", "Ulambe", "Vindorime", "Wanolde", "Yarimble", "Zocalime", "Bilonde",
  // — terminación -ix —
  "Andolix", "Barumix", "Calendix", "Dromblix", "Farolix", "Gandumix", "Hilombix", "Jocarix",
  "Kalendix", "Lorumix", "Mandolix", "Nocambix", "Opalix", "Parundix", "Quiralix", "Rondomix",
  "Salembix", "Tilorix", "Umbalix", "Vandomix",
  // — terminación -oy —
  "Andaloy", "Barumboy", "Calindoy", "Dolomboy", "Farindoy", "Gandaloy", "Hilomboy", "Jocaroy",
  "Kalimboy", "Lorandoy", "Mandaloy", "Nicomboy", "Opaloy", "Parimboy", "Quiraloy", "Rondaloy",
  "Salomboy", "Tilandoy", "Umbaloy", "Vindaroy",
] as const;

/** Nombre aleatorio de la lista. */
export function randomName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}

/** Color aleatorio de la paleta pastel-plastilina. */
export function randomColor(): string {
  return PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];
}
