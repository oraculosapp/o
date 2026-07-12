import { describe, expect, it } from "vitest";
import { sanitizeProfileUrl, socialToJson, validateHandle } from "../profile";

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

  it("descarta enlaces con esquema peligroso (anti-XSS C-1)", () => {
    expect(
      socialToJson([
        { label: "XSS", url: "javascript:alert(1)" },
        { label: "Data", url: "data:text/html,<script>alert(1)</script>" },
        { label: "OK", url: "https://x.com/paqo" },
      ])
    ).toEqual({ OK: "https://x.com/paqo" });
  });

  it("prefija https:// a las etiquetas sin esquema", () => {
    expect(socialToJson([{ label: "Web", url: "ejemplo.com/paqo" }])).toEqual({
      Web: "https://ejemplo.com/paqo",
    });
  });
});

describe("sanitizeProfileUrl (anti-XSS C-1)", () => {
  it("acepta http/https tal cual", () => {
    expect(sanitizeProfileUrl("https://x.com/paqo")).toBe("https://x.com/paqo");
    expect(sanitizeProfileUrl("http://foo.test")).toBe("http://foo.test");
  });

  it("prefija https:// cuando no hay esquema", () => {
    expect(sanitizeProfileUrl("ejemplo.com")).toBe("https://ejemplo.com");
    expect(sanitizeProfileUrl("  ejemplo.com/ruta  ")).toBe("https://ejemplo.com/ruta");
  });

  it("rechaza esquemas peligrosos y vacío", () => {
    expect(sanitizeProfileUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeProfileUrl("JavaScript:alert(1)")).toBeNull();
    expect(sanitizeProfileUrl("data:text/html,x")).toBeNull();
    expect(sanitizeProfileUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeProfileUrl("mailto:a@b.com")).toBeNull();
    expect(sanitizeProfileUrl("   ")).toBeNull();
  });
});
