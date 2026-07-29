import { describe, expect, it } from "vitest";
import {
  FOUND_COOLDOWN_MS,
  FOUND_STORAGE_KEY,
  PAQO_FOUND_MESSAGES,
  parseLastFoundAt,
  pickFoundMessage,
  shouldCelebrateFound,
} from "../paqo-found";

describe("paqo-found — constantes de la ceremonia", () => {
  it("el cooldown por visita es de 2 minutos", () => {
    expect(FOUND_COOLDOWN_MS).toBe(120_000);
  });

  it("la clave de persistencia va en el espacio de nombres de la casa", () => {
    expect(FOUND_STORAGE_KEY).toMatch(/^phy:/);
  });

  it("hay 3-4 variantes en voz de Paqo, únicas y breves", () => {
    expect(PAQO_FOUND_MESSAGES.length).toBeGreaterThanOrEqual(3);
    expect(PAQO_FOUND_MESSAGES.length).toBeLessThanOrEqual(4);
    expect(new Set(PAQO_FOUND_MESSAGES).size).toBe(PAQO_FOUND_MESSAGES.length);
    for (const m of PAQO_FOUND_MESSAGES) {
      expect(m.length).toBeGreaterThan(20);
      expect(m.length).toBeLessThanOrEqual(90); // cabe en la píldora sin desbordar
    }
  });
});

describe("parseLastFoundAt", () => {
  it("devuelve null sin valor guardado", () => {
    expect(parseLastFoundAt(null)).toBeNull();
    expect(parseLastFoundAt(undefined)).toBeNull();
  });

  it("devuelve null con basura o valores no positivos", () => {
    expect(parseLastFoundAt("ayer")).toBeNull();
    expect(parseLastFoundAt("")).toBeNull();
    expect(parseLastFoundAt("0")).toBeNull();
    expect(parseLastFoundAt("-5")).toBeNull();
  });

  it("parsea un instante epoch válido", () => {
    expect(parseLastFoundAt("1700000000000")).toBe(1_700_000_000_000);
  });
});

describe("shouldCelebrateFound — primera vez + cooldown por visita", () => {
  const now = 1_700_000_000_000;

  it("celebra la primera vez (sin registro previo)", () => {
    expect(shouldCelebrateFound(null, now)).toBe(true);
    expect(shouldCelebrateFound(undefined, now)).toBe(true);
  });

  it("NO repite si el viajero entra y sale del claro en menos de 2 min", () => {
    expect(shouldCelebrateFound(now - 1_000, now)).toBe(false);
    expect(shouldCelebrateFound(now - 119_999, now)).toBe(false);
  });

  it("vuelve a celebrar justo al cumplirse el cooldown", () => {
    expect(shouldCelebrateFound(now - FOUND_COOLDOWN_MS, now)).toBe(true);
    expect(shouldCelebrateFound(now - 10 * 60_000, now)).toBe(true);
  });

  it("con un instante en el futuro (reloj movido) prefiere callar", () => {
    expect(shouldCelebrateFound(now + 60_000, now)).toBe(false);
  });

  it("acepta un cooldown a medida", () => {
    expect(shouldCelebrateFound(now - 5_000, now, 1_000)).toBe(true);
    expect(shouldCelebrateFound(now - 500, now, 1_000)).toBe(false);
  });
});

describe("pickFoundMessage — selector de la voz de Paqo", () => {
  it("siempre devuelve una de las variantes escritas", () => {
    for (let i = 0; i < 200; i++) {
      expect(PAQO_FOUND_MESSAGES).toContain(pickFoundMessage(i));
    }
  });

  it("es determinista para la misma semilla", () => {
    expect(pickFoundMessage(1_700_000_000_003)).toBe(pickFoundMessage(1_700_000_000_003));
  });

  it("evita repetir el mensaje anterior", () => {
    for (let i = 0; i < 50; i++) {
      const first = pickFoundMessage(i);
      expect(pickFoundMessage(i, first)).not.toBe(first);
    }
  });

  it("tolera semillas raras (NaN, negativas, decimales)", () => {
    expect(PAQO_FOUND_MESSAGES).toContain(pickFoundMessage(Number.NaN));
    expect(PAQO_FOUND_MESSAGES).toContain(pickFoundMessage(-7));
    expect(PAQO_FOUND_MESSAGES).toContain(pickFoundMessage(3.9));
  });

  it("con una sola variante la devuelve aunque sea la anterior", () => {
    expect(pickFoundMessage(5, "sólo yo", ["sólo yo"])).toBe("sólo yo");
  });

  it("con lista vacía devuelve cadena vacía (degrada sin romper)", () => {
    expect(pickFoundMessage(5, null, [])).toBe("");
  });
});
