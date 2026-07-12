import { describe, expect, it } from "vitest";
import { socialToJson, validateHandle } from "../profile";

describe("validateHandle", () => {
  it("acepta handles válidos (minúsculas, números, guion, guion bajo)", () => {
    expect(validateHandle("paqo")).toBeNull();
    expect(validateHandle("viajero_23")).toBeNull();
    expect(validateHandle("brangulio-nin")).toBeNull();
  });

  it("rechaza handles demasiado cortos o largos", () => {
    expect(validateHandle("ab")).toMatch(/al menos/);
    expect(validateHandle("x".repeat(33))).toMatch(/no puede pasar/);
  });

  it("rechaza caracteres no permitidos", () => {
    expect(validateHandle("Paqo!")).toMatch(/minúsculas/);
    expect(validateHandle("con espacio")).toMatch(/minúsculas/);
  });
});

describe("socialToJson", () => {
  it("serializa etiquetas→url descartando entradas vacías", () => {
    expect(
      socialToJson([
        { label: "Twitter", url: "https://x.com/paqo" },
        { label: "", url: "https://ignorar.com" },
        { label: "Web", url: "  " },
      ])
    ).toEqual({ Twitter: "https://x.com/paqo" });
  });

  it("recorta espacios en etiqueta y url", () => {
    expect(socialToJson([{ label: "  IG ", url: "  https://insta  " }])).toEqual({
      IG: "https://insta",
    });
  });
});
