import { describe, expect, it } from "vitest";
import { isGameRunningIn, shouldReloadNow } from "../reload-coordinator";

describe("shouldReloadNow", () => {
  it("recarga cuando la pestaña está visible y no hay partida", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: false })).toBe(true);
  });

  it("NO recarga en background (pestaña oculta) aunque no haya partida", () => {
    expect(shouldReloadNow({ visible: false, gameRunning: false })).toBe(false);
  });

  it("NO recarga si hay una partida en curso aunque la pestaña sea visible", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: true })).toBe(false);
  });

  it("NO recarga si está oculta Y hay partida", () => {
    expect(shouldReloadNow({ visible: false, gameRunning: true })).toBe(false);
  });
});

describe("isGameRunningIn", () => {
  const runningWorld = { __PAQO__: { game: { snapshot: () => ({ phase: "running" }) } } };

  it("es true cuando phase === 'running'", () => {
    expect(isGameRunningIn(runningWorld)).toBe(true);
  });

  it("es false para otras fases (idle, ended, etc.)", () => {
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({ phase: "idle" }) } } })).toBe(
      false,
    );
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({ phase: "ended" }) } } })).toBe(
      false,
    );
  });

  it("es false (degrada) si no existe el global __PAQO__ o su cadena", () => {
    expect(isGameRunningIn({})).toBe(false);
    expect(isGameRunningIn({ __PAQO__: {} })).toBe(false);
    expect(isGameRunningIn({ __PAQO__: { game: {} } })).toBe(false);
    expect(isGameRunningIn(undefined)).toBe(false);
    expect(isGameRunningIn(null)).toBe(false);
  });

  it("es false (degrada) si snapshot lanza una excepción", () => {
    const boom = {
      __PAQO__: {
        game: {
          snapshot: () => {
            throw new Error("boom");
          },
        },
      },
    };
    expect(isGameRunningIn(boom)).toBe(false);
  });

  it("es false si snapshot no devuelve phase", () => {
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({}) } } })).toBe(false);
  });
});
