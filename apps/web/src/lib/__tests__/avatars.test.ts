import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  BUILDS,
  archetypeUrl,
  avatarFileNames,
  avatarId,
  genGlbUrl,
  isArchetypeId,
  isAvatarAvailable,
  isAvatarId,
  isBuildId,
  parseAvatarId,
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

  it("mapea la miniatura MODELADA por build (gen), con build neutro por defecto", () => {
    expect(thumbUrl("chaman")).toBe("/assets/avatars/thumbs/gen/chaman-n.webp");
    expect(thumbUrl("chaman", "f")).toBe("/assets/avatars/thumbs/gen/chaman-f.webp");
  });

  it("reconoce ids válidos e inválidos", () => {
    expect(isArchetypeId("astronomo")).toBe(true);
    expect(isArchetypeId("inexistente")).toBe(false);
  });

  it("marca hacker-f como disponible; el resto sigue durmiendo", () => {
    expect(isAvatarAvailable("hacker", "f")).toBe(true);
    expect(isAvatarAvailable("hacker", "m")).toBe(false);
    expect(isAvatarAvailable("chaman", "f")).toBe(false);
  });
});

describe("avatares MODELADOS (arquetipo + build)", () => {
  it("expone los 3 builds f/m/n", () => {
    expect(BUILDS.map((b) => b.id)).toEqual(["f", "m", "n"]);
    expect(isBuildId("n")).toBe(true);
    expect(isBuildId("x")).toBe(false);
  });

  it("compone el id de avatar y su GLB/parse (respeta arquetipos con guion)", () => {
    expect(avatarId("vampiro", "f")).toBe("vampiro-f");
    expect(avatarId("dedo-verde", "n")).toBe("dedo-verde-n");
    expect(genGlbUrl("dedo-verde", "n")).toBe("/assets/avatars/gen/dedo-verde-n.glb");
    expect(parseAvatarId("dedo-verde-n")).toEqual({ archetype: "dedo-verde", build: "n" });
  });

  it("valida ids de avatar y rechaza los 9 ids 'pelados' viejos", () => {
    expect(isAvatarId("hacker-m")).toBe(true);
    expect(isAvatarId("dedo-verde-f")).toBe(true);
    expect(isAvatarId("hacker")).toBe(false); // id de arquetipo, no de avatar
    expect(isAvatarId("dedo-verde")).toBe(false);
    expect(isAvatarId("hacker-x")).toBe(false); // build inválido
    expect(isAvatarId("inexistente-f")).toBe(false);
  });
});
