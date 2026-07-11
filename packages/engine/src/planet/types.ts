/**
 * Subconjunto del preset de biósfera que consume el motor jugable.
 * El preset completo (agua, partículas, props...) vive en
 * @phygitalia/content/biospheres/paqo.json; aquí sólo tipamos lo que el
 * engine usa hoy para generar el planeta caminable.
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
  };
  sky: { gradientTop: string; gradientBottom: string };
  fog: { color: string };
  postFx: { outline: { color: string } };
}
