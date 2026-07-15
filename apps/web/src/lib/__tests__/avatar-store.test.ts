import { describe, expect, it } from "vitest";
import {
  defaultSelection,
  getStoredArchetype,
  normalizeSelection,
  worldConfigFromSelection,
} from "../avatar-store";
import { PASTEL_COLORS } from "../names";

const HEX = /^#[0-9a-f]{6}$/;

describe("avatar-store — selección {color} + compat (S8)", () => {
  it("defaultSelection asigna un color pastel de la paleta", () => {
    const sel = defaultSelection();
    expect(sel.color).toMatch(HEX);
    expect(PASTEL_COLORS).toContain(sel.color);
  });

  it("normaliza el formato NUEVO { color } (con o sin design)", () => {
    expect(normalizeSelection({ color: "#9EC7F2" })).toEqual({ color: "#9ec7f2" });
    expect(normalizeSelection({ design: "nube", color: "#f2887f" })).toEqual({ color: "#f2887f" });
  });

  it("COMPAT: formato viejo S7 con color real conserva su tint.primary", () => {
    const old = {
      archetype: "vampiro",
      build: "f",
      tint: { primary: "#B0475A", secondary: "#6a6f86", hair: "#7a6f86", skin: "#ffffff", accent: "#e05a6e" },
    };
    expect(normalizeSelection(old)).toEqual({ color: "#b0475a" });
  });

  it("COMPAT: formato viejo con tinte blanco-fábrica → color pastel aleatorio", () => {
    const old = { archetype: "hacker", build: "n", tint: { primary: "#ffffff" } };
    const sel = normalizeSelection(old);
    expect(sel).not.toBeNull();
    expect(PASTEL_COLORS).toContain(sel!.color);
  });

  it("COMPAT: formato viejo sin tinte → color pastel aleatorio", () => {
    const sel = normalizeSelection({ archetype: "dedo-verde" });
    expect(sel).not.toBeNull();
    expect(PASTEL_COLORS).toContain(sel!.color);
  });

  it("rechaza basura (null, strings, colores malformados)", () => {
    expect(normalizeSelection(null)).toBeNull();
    expect(normalizeSelection("vampiro")).toBeNull();
    expect(normalizeSelection({ color: "rojo" })).toBeNull();
    expect(normalizeSelection({ color: "#12345" })).toBeNull();
    expect(normalizeSelection({})).toBeNull();
  });

  it("worldConfigFromSelection apunta al GLB nube con el color como primary", () => {
    const cfg = worldConfigFromSelection({ color: "#8fd8c8" });
    expect(cfg.archetypeUrl).toBe("/assets/avatars/gen/nube.glb");
    expect(cfg.tint).toEqual({ primary: "#8fd8c8" });
  });

  it("la presencia siempre transmite el diseño único 'nube'", () => {
    expect(getStoredArchetype()).toBe("nube");
  });
});
