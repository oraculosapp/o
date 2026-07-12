import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  archetypeUrl,
  avatarFileNames,
  isArchetypeId,
  thumbUrl,
} from "../avatars";

describe("catálogo de avatares", () => {
  it("tiene los 9 arquetipos con ids en minúsculas/guion", () => {
    expect(ARCHETYPES).toHaveLength(9);
    for (const a of ARCHETYPES) {
      expect(a.id).toMatch(/^[a-z0-9-]+$/);
      expect(a.name.length).toBeGreaterThan(0);
    }
  });

  it("deriva 18 nombres de archivo (9 × m/f) sin duplicados", () => {
    const names = avatarFileNames();
    expect(names).toHaveLength(18);
    expect(new Set(names).size).toBe(18);
    expect(names).toContain("hacker-m");
    expect(names).toContain("dedo-verde-f");
  });

  it("mapea arquetipo+género a la URL del GLB según la convención", () => {
    expect(archetypeUrl("hacker", "m")).toBe("/assets/avatars/hacker-m.glb");
    expect(archetypeUrl("dedo-verde", "f")).toBe("/assets/avatars/dedo-verde-f.glb");
  });

  it("mapea la miniatura a public/assets/avatars/thumbs", () => {
    expect(thumbUrl("chaman")).toBe("/assets/avatars/thumbs/chaman.webp");
  });

  it("reconoce ids válidos e inválidos", () => {
    expect(isArchetypeId("astronomo")).toBe(true);
    expect(isArchetypeId("inexistente")).toBe(false);
  });
});
