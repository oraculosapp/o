import { describe, expect, it } from "vitest";
import { pickPadChord, pickPadNote, PAD_SCALE } from "@phygitalia/engine";

/**
 * Regresión H1 — "la reverberación rota" del pad. AmbientBed elegía las 3 notas
 * del acorde independientemente y al azar de la pentatónica (≈44% de unísono
 * entre ≥2 voces); con los detunes fijos −6/+5/+9 cents un unísono BATE a ~1 Hz,
 * y una segunda adyacente (C3-D3, D3-E3, G3-A3) batiría casi igual. Con la
 * pestaña oculta —sin rAF que evolucione la cama— el acorde feo quedaba clavado
 * para siempre. El fix: un selector PURO que garantiza notas distintas de la
 * escala, sin unísonos y sin segundas adyacentes entre voces.
 */

/** Semitonos entre dos frecuencias (para clasificar el intervalo). */
function semitones(a: number, b: number): number {
  return Math.abs(12 * Math.log2(a / b));
}

/** RNG determinista (LCG) para sembrar las iteraciones de forma reproducible. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // LCG clásico (Numerical Recipes); basta para barrer el espacio de elección.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("pickPadChord — acorde de pad sin unísonos ni segundas (H1)", () => {
  it("devuelve 3 notas, todas dentro de PAD_SCALE", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const chord = pickPadChord(seededRng(seed));
      expect(chord).toHaveLength(3);
      for (const note of chord) expect(PAD_SCALE).toContain(note);
    }
  });

  it("nunca hay dos voces en unísono (mismo grado) en muchas iteraciones", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const chord = pickPadChord(seededRng(seed));
      const unique = new Set(chord);
      expect(unique.size).toBe(3);
    }
  });

  it("ninguna pareja de voces queda en segunda adyacente (< 2.5 semitonos)", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const chord = pickPadChord(seededRng(seed));
      for (let i = 0; i < chord.length; i++) {
        for (let j = i + 1; j < chord.length; j++) {
          // Unísono (0) y segunda (~2) son los intervalos batientes: prohibidos.
          expect(semitones(chord[i], chord[j])).toBeGreaterThanOrEqual(2.5);
        }
      }
    }
  });

  it("por defecto usa Math.random sin lanzar", () => {
    const chord = pickPadChord();
    expect(chord).toHaveLength(3);
    expect(new Set(chord).size).toBe(3);
  });
});

describe("pickPadNote — una nota que no choca con las voces vivas", () => {
  it("evita unísono y segunda con TODAS las notas de `avoid`", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const rng = seededRng(seed);
      // Toma dos notas al azar de la escala como voces ya sonando.
      const a = PAD_SCALE[Math.floor(rng() * PAD_SCALE.length)];
      const b = PAD_SCALE[Math.floor(rng() * PAD_SCALE.length)];
      const note = pickPadNote([a, b], rng);
      expect(PAD_SCALE).toContain(note);
      expect(semitones(note, a)).toBeGreaterThanOrEqual(2.5);
      expect(semitones(note, b)).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("sin restricciones (`avoid` vacío) devuelve una nota de la escala", () => {
    const note = pickPadNote([], seededRng(42));
    expect(PAD_SCALE).toContain(note);
  });
});
