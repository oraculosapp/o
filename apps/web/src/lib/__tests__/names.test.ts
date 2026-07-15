import { describe, expect, it } from "vitest";
import { NAMES, PASTEL_COLORS, randomColor, randomName } from "../names";

describe("names — identidad aleatoria (S8)", () => {
  it("tiene al menos 120 nombres, todos únicos", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(120);
    expect(new Set(NAMES).size).toBe(NAMES.length);
  });

  it("incluye los nombres de la referencia", () => {
    for (const ref of ["Drumbli", "Bambu", "Coponi", "Perenoie", "Acatombe", "Semblix", "Ocotoy", "Mambu", "Jojonopi"]) {
      expect(NAMES).toContain(ref);
    }
  });

  it("los nombres son palabras capitalizadas sin espacios ni símbolos", () => {
    for (const n of NAMES) {
      expect(n).toMatch(/^[A-Z][a-z]+$/);
      expect(n.length).toBeGreaterThanOrEqual(4);
      expect(n.length).toBeLessThanOrEqual(12);
    }
  });

  it("respetan el sabor fonético (terminaciones -i/-u/-e/-ix/-oy)", () => {
    for (const n of NAMES) {
      expect(/(?:i|u|e|ix|oy)$/.test(n)).toBe(true);
    }
  });

  it("randomName devuelve nombres de la lista", () => {
    for (let i = 0; i < 50; i++) {
      expect(NAMES).toContain(randomName());
    }
  });

  it("la paleta pastel tiene ~16 colores hex válidos y únicos", () => {
    expect(PASTEL_COLORS.length).toBe(16);
    expect(new Set(PASTEL_COLORS.map((c) => c.toLowerCase())).size).toBe(PASTEL_COLORS.length);
    for (const c of PASTEL_COLORS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("randomColor devuelve colores de la paleta", () => {
    for (let i = 0; i < 50; i++) {
      expect(PASTEL_COLORS).toContain(randomColor());
    }
  });
});
