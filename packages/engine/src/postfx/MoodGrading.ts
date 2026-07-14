/**
 * MoodGrading — generación PROCEDURAL de LUTs 3D de color grading (equipo Atmos).
 *
 * Sintetiza tablas de color (LUT 3D) por código —CERO archivos .cube— que dan el
 * "mood" cinematográfico a la escena. La lib `postprocessing` aporta
 * `LookupTexture.createNeutral(size)` (una LUT identidad en Float32, RGBA) y el
 * `LUT3DEffect` que la muestrea como último pase del post-proceso. Aquí partimos
 * de la LUT neutral y aplicamos, texel a texel, una cadena de grading en espacio
 * de DISPLAY (sRGB): exposición → temperatura/tinte → lift/gamma/gain (ASC CDL) →
 * S-curve de contraste → tinte de sombras/altas por luma → saturación.
 *
 * REGLA DE MARCA: cada transform es SUTIL a propósito (desplazamientos ~2–5 % de
 * canal) para no matar nunca la niebla lila (#B18BC9), el oro (#e3b063) ni el
 * horizonte flamingo (#F79FA8/#FF9E6B). Sutileza > efectismo.
 *
 * NOTA: módulo del engine — NO importa React.
 */
import { LookupTexture } from "postprocessing";

/** Identificadores de los "moods" (looks de color grading) disponibles. */
export const MOOD_IDS = ["natural", "calido", "frio", "drama", "cine", "vivo", "brillante"] as const;

/** Id de un mood válido (unión literal derivada de {@link MOOD_IDS}). */
export type MoodId = (typeof MOOD_IDS)[number];

// ─── KNOBS (ajustables) ──────────────────────────────────────────────────────

/**
 * Lado de la LUT (32³ ≈ 33k texels). El enunciado pide 32³ o 48³; 32 es de sobra
 * con interpolación tetraédrica + datos Float32 (LUT_PRECISION_HIGH). Subir a 48
 * afina degradados a costa de ~3× memoria/tiempo de generación (una sola vez).
 */
export const LUT_SIZE = 32;

/** Coeficientes de luminancia Rec.709 (percepción de brillo para pesos de luma). */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

// ─── modelo de grading ───────────────────────────────────────────────────────

type Vec3 = [number, number, number];

interface Grade {
  /** Multiplicador de exposición global (0 = neutro; +0.06 ≈ +6 %). */
  exposure: number;
  /** Temperatura: + cálido (sube R, baja B), − frío (baja R, sube B). */
  temperature: number;
  /** Tinte: + magenta (baja G), − verde (sube G). */
  tint: number;
  /** ASC CDL offset (lift) por canal — levanta/hunde sombras. */
  lift: Vec3;
  /** ASC CDL power (gamma) por canal — >1 aclara medios, <1 los oscurece. */
  gamma: Vec3;
  /** ASC CDL slope (gain) por canal — escala altas luces. */
  gain: Vec3;
  /** Fuerza de la S-curve de contraste (0 = nada, + sube, − suaviza). */
  contrast: number;
  /** Dirección de color empujada en las SOMBRAS (por peso de luma baja). */
  shadowTint: Vec3;
  shadowAmt: number;
  /** Dirección de color empujada en las ALTAS luces (por peso de luma alta). */
  highlightTint: Vec3;
  highlightAmt: number;
  /** Desaturación SÓLO de altas luces (0 = nada; 1 = gris). */
  highlightDesat: number;
  /** Saturación global (1 = neutro). */
  saturation: number;
}

const NEUTRAL: Grade = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  contrast: 0,
  shadowTint: [0, 0, 0],
  shadowAmt: 0,
  highlightTint: [0, 0, 0],
  highlightAmt: 0,
  highlightDesat: 0,
  saturation: 1,
};

/** Construye un Grade completo a partir de un parche sobre el neutro. */
function grade(patch: Partial<Grade>): Grade {
  return { ...NEUTRAL, ...patch };
}

/**
 * Recetas de arte por mood. Valores finales elegidos para respetar la paleta de
 * marca (ver cabecera). Todos los desplazamientos son deliberadamente contenidos.
 */
const MOOD_GRADES: Record<MoodId, Grade> = {
  // Identidad pura: la LUT no altera un solo texel.
  natural: NEUTRAL,

  // Sol de miel: +temperatura, lift dorado en sombras, sombras apenas magenta.
  calido: grade({
    exposure: 0.02,
    temperature: 0.1,
    tint: 0.02,
    lift: [0.018, 0.012, 0.004],
    gain: [1.02, 1.0, 0.985],
    contrast: 0.05,
    shadowTint: [0.012, 0.0, 0.012], // pizca de magenta en sombras
    shadowAmt: 0.5,
    saturation: 1.05,
  }),

  // Aire frío: −temperatura hacia azul-cian, altas luces algo desaturadas.
  frio: grade({
    temperature: -0.12,
    tint: -0.015,
    lift: [-0.004, 0.002, 0.016],
    contrast: 0.03,
    highlightDesat: 0.14,
    saturation: 0.98,
  }),

  // Drama: contraste alto, sombras aplastadas hacia púrpura, saturación 0.85.
  drama: grade({
    contrast: 0.18,
    lift: [-0.016, -0.018, -0.006],
    gamma: [0.96, 0.95, 0.98],
    gain: [0.99, 0.98, 1.0],
    shadowTint: [0.02, -0.008, 0.03], // violeta (#B18BC9-ish) en sombras
    shadowAmt: 0.9,
    saturation: 0.85,
  }),

  // Teal-orange clásico: sombras teal, altas naranja, contraste medio.
  cine: grade({
    contrast: 0.1,
    shadowTint: [-0.04, 0.01, 0.05], // hacia teal
    shadowAmt: 1.0,
    highlightTint: [0.06, 0.016, -0.05], // hacia naranja
    highlightAmt: 1.0,
    saturation: 1.06,
  }),

  // Vívido: saturación ~1.25, contraste leve.
  vivo: grade({
    exposure: 0.02,
    contrast: 0.06,
    saturation: 1.25,
  }),

  // Brillante/soft: sombras levantadas, +exposición suave, look lavado.
  brillante: grade({
    exposure: 0.06,
    lift: [0.04, 0.04, 0.05], // negros lechosos, pizca fría → aire
    gamma: [1.06, 1.06, 1.05],
    contrast: -0.05,
    saturation: 0.98,
  }),
};

// ─── helpers de color (sRGB display, todo en [0,1]) ──────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function luma(r: number, g: number, b: number): number {
  return r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
}

/** smoothstep(edge0, edge1, x) canónico. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * S-curve de contraste centrada en 0.5. `k>0` acerca a smoothstep (más
 * contraste, sigmoide); `k<0` se aleja (suaviza). Fórmula única y estable.
 */
function contrastCh(x: number, k: number): number {
  const s = smoothstep(0, 1, x);
  return x + k * (s - x);
}

/**
 * Genera la LUT 3D PROCEDURAL de un mood. Parte de la neutral (identidad) y
 * reescribe cada texel aplicando la cadena de grading en espacio de display.
 * El texel de índice (r,g,b) representa el color de ENTRADA (r,g,b)/(size−1);
 * guardamos ahí su color de SALIDA graduado.
 */
export function createMoodLUT(id: MoodId): LookupTexture {
  const lut = LookupTexture.createNeutral(LUT_SIZE);
  lut.name = `mood-${id}`;

  // "natural" = identidad: dejamos la neutral tal cual (ni un texel cambia).
  if (id === "natural") {
    lut.needsUpdate = true;
    return lut;
  }

  const g = MOOD_GRADES[id];
  const data = lut.image.data as Float32Array;
  const expMul = Math.pow(2, g.exposure);

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let gc = data[i + 1];
    let b = data[i + 2];

    // 1) Exposición global.
    r *= expMul;
    gc *= expMul;
    b *= expMul;

    // 2) Temperatura (R↔B) y tinte (G).
    r *= 1 + g.temperature * 0.35;
    b *= 1 - g.temperature * 0.35;
    gc *= 1 - g.tint * 0.3;

    // 3) ASC CDL: (in * slope + offset) ^ (1/power). power>1 aclara medios.
    r = Math.pow(clamp01(r * g.gain[0] + g.lift[0]), 1 / g.gamma[0]);
    gc = Math.pow(clamp01(gc * g.gain[1] + g.lift[1]), 1 / g.gamma[1]);
    b = Math.pow(clamp01(b * g.gain[2] + g.lift[2]), 1 / g.gamma[2]);

    // 4) S-curve de contraste por canal.
    if (g.contrast !== 0) {
      r = contrastCh(r, g.contrast);
      gc = contrastCh(gc, g.contrast);
      b = contrastCh(b, g.contrast);
    }

    // 5) Tinte de sombras/altas y desaturación de altas, pesados por luma.
    const l = luma(r, gc, b);
    if (g.shadowAmt !== 0) {
      const w = (1 - smoothstep(0, 0.5, l)) * g.shadowAmt;
      r += g.shadowTint[0] * w;
      gc += g.shadowTint[1] * w;
      b += g.shadowTint[2] * w;
    }
    if (g.highlightAmt !== 0) {
      const w = smoothstep(0.5, 1, l) * g.highlightAmt;
      r += g.highlightTint[0] * w;
      gc += g.highlightTint[1] * w;
      b += g.highlightTint[2] * w;
    }
    if (g.highlightDesat !== 0) {
      const w = smoothstep(0.5, 1, l) * g.highlightDesat;
      r += (l - r) * w;
      gc += (l - gc) * w;
      b += (l - b) * w;
    }

    // 6) Saturación global (recalcula luma tras los tintes).
    if (g.saturation !== 1) {
      const l2 = luma(r, gc, b);
      r = l2 + (r - l2) * g.saturation;
      gc = l2 + (gc - l2) * g.saturation;
      b = l2 + (b - l2) * g.saturation;
    }

    data[i] = clamp01(r);
    data[i + 1] = clamp01(gc);
    data[i + 2] = clamp01(b);
    // alpha (data[i+3]) queda en 1.
  }

  lut.needsUpdate = true;
  return lut;
}
