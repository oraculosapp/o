/**
 * Subconjunto del preset de biósfera que consume el motor jugable.
 * El preset completo (tipado exhaustivo en @phygitalia/content/src/types.ts)
 * vive en @phygitalia/content/biospheres/paqo.json; aquí tipamos lo que el
 * engine usa hoy para generar el planeta caminable, la vegetación, el agua,
 * la atmósfera y el post-procesado. Campos opcionales = degradación elegante
 * si un preset futuro los omite.
 */
export interface BiospherePreset {
  palette: {
    primary: string;
    secondary: string;
    accent: string;
    ground: string;
    sky: string;
  };
  terrain: {
    heightNoise: { amplitude: number; frequency: number; octaves: number };
    ridges?: { enabled: boolean; steepness: number };
    centralClearing?: { enabled: boolean; radius: number; flatness: number };
    rockScatter?: { density: number; mossy?: boolean; lowPolyFacets?: number };
  };
  vegetation?: {
    grass?: { density?: number; height?: number; windSway?: number };
    trees?: { type?: string; density?: number; mossHang?: boolean; clusterAtEdges?: boolean };
    shrubs?: { type?: string; density?: number };
    flowers?: { density?: number; colors?: string[] };
    special?: { type?: string; density?: number };
  };
  water?: {
    present?: boolean;
    bodies?: string[];
    color?: string;
    flowSpeed?: number;
    foam?: number;
    reflectivity?: number;
  };
  sky: { gradientTop: string; gradientBottom: string };
  lighting?: {
    keyColor?: string;
    keyIntensity?: number;
    ambientColor?: string;
    ambientIntensity?: number;
    /** Rebote cálido del cielo para la HemisphereLight (cara superior). */
    skyBounceColor?: string;
  };
  fog: {
    color: string;
    density?: number;
    groundLayer?: { enabled?: boolean; height?: number; rolling?: boolean };
  };
  /** Colores de las partículas-píxel interactivas (oro/rosa/lila). El motor cae a defaults si falta. */
  particles?: Array<{ type?: string; density?: number; color?: string; colors?: string[]; size?: number }>;
  postFx: { bloom?: number; outline: { color: string } };
}
