import { describe, expect, it } from "vitest";
import { isNewVersion, parseVersion } from "../update-check";

describe("parseVersion", () => {
  it("extrae un build id string no vacío", () => {
    expect(parseVersion({ v: "abc123" })).toBe("abc123");
  });

  it("devuelve null si v está vacío", () => {
    expect(parseVersion({ v: "" })).toBeNull();
  });

  it("devuelve null si v no es string", () => {
    expect(parseVersion({ v: 42 })).toBeNull();
    expect(parseVersion({ v: null })).toBeNull();
    expect(parseVersion({ v: { nested: true } })).toBeNull();
  });

  it("devuelve null si falta la clave v", () => {
    expect(parseVersion({})).toBeNull();
    expect(parseVersion({ version: "x" })).toBeNull();
  });

  it("devuelve null para cuerpos no-objeto (HTML de error, undefined, etc.)", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion("<!doctype html>")).toBeNull();
    expect(parseVersion(123)).toBeNull();
  });
});

describe("isNewVersion", () => {
  it("es true cuando embebido y remoto difieren", () => {
    expect(isNewVersion("build-1", "build-2")).toBe(true);
  });

  it("es false cuando coinciden (misma versión)", () => {
    expect(isNewVersion("build-1", "build-1")).toBe(false);
  });

  it("es false (conservador) si falta el id embebido", () => {
    expect(isNewVersion(null, "build-2")).toBe(false);
    expect(isNewVersion(undefined, "build-2")).toBe(false);
    expect(isNewVersion("", "build-2")).toBe(false);
  });

  it("es false (conservador) si falta el id remoto", () => {
    expect(isNewVersion("build-1", null)).toBe(false);
    expect(isNewVersion("build-1", undefined)).toBe(false);
    expect(isNewVersion("build-1", "")).toBe(false);
  });

  it("es false si faltan ambos", () => {
    expect(isNewVersion(null, null)).toBe(false);
  });

  it("integración: parseVersion + isNewVersion sobre un payload real", () => {
    const remote = parseVersion({ v: "deploy-nuevo" });
    expect(isNewVersion("deploy-viejo", remote)).toBe(true);
    expect(isNewVersion("deploy-nuevo", remote)).toBe(false);
  });
});
