import { beforeAll, describe, expect, it } from "vitest";
import { InputManager, type ActionState } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO/MANDOS] InputManager — CORRER móvil + estado de acción con vuelo.
 *  - setRun(true/false): hold arcade del botón Correr (OR con Shift del teclado).
 *  - pressRun(): variante toggle.
 *  - setInputEnabled(false) suelta el correr móvil (no queda "pegado").
 *  - ActionState ahora lleva `flying` (etiqueta "Caer" del botón de salto).
 *
 * El InputManager toca DOM (joystick, listeners): en node lo mockeamos mínimo.
 */

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  const fakeDomEl = () => ({
    style: {} as Record<string, string>,
    appendChild: () => {},
    remove: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  if (typeof g.document === "undefined") {
    g.document = { createElement: fakeDomEl };
  }
  if (typeof g.window === "undefined") {
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
  }
  if (typeof g.getComputedStyle === "undefined") {
    g.getComputedStyle = () => ({ position: "relative" });
  }
});

/** Contenedor falso suficiente para el constructor (joystick DOM + listeners). */
function fakeContainer(): HTMLElement {
  return {
    style: {} as Record<string, string>,
    appendChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {},
  } as unknown as HTMLElement;
}

describe("InputManager — correr móvil", () => {
  it("setRun(true) hace run=true en consumeMove; setRun(false) lo apaga (hold)", () => {
    const input = new InputManager(fakeContainer());
    expect(input.consumeMove().run).toBe(false);

    input.setRun(true);
    expect(input.consumeMove().run).toBe(true);
    // Es estado sostenido (hold), no edge: sigue corriendo hasta soltar.
    expect(input.consumeMove().run).toBe(true);

    input.setRun(false);
    expect(input.consumeMove().run).toBe(false);
    input.dispose();
  });

  it("pressRun() alterna correr/caminar (toggle)", () => {
    const input = new InputManager(fakeContainer());
    input.pressRun();
    expect(input.consumeMove().run).toBe(true);
    input.pressRun();
    expect(input.consumeMove().run).toBe(false);
    input.dispose();
  });

  it("setInputEnabled(false) suelta el correr móvil (no queda pegado)", () => {
    const input = new InputManager(fakeContainer());
    input.setRun(true);
    input.setInputEnabled(false); // p.ej. el chat tomó foco
    expect(input.consumeMove().run).toBe(false);
    input.setInputEnabled(true); // al volver, NO sigue corriendo solo
    expect(input.consumeMove().run).toBe(false);
    input.dispose();
  });

  it("pressJump/pressGrab siguen siendo edges de un solo frame", () => {
    const input = new InputManager(fakeContainer());
    input.pressJump();
    input.pressGrab();
    const f1 = input.consumeMove();
    expect(f1.jump).toBe(true);
    expect(f1.grab).toBe(true);
    const f2 = input.consumeMove();
    expect(f2.jump).toBe(false);
    expect(f2.grab).toBe(false);
    input.dispose();
  });
});

describe("InputManager — ActionState con flying", () => {
  it("notifica el cambio de `flying` (el botón de salto pasa a 'Caer')", () => {
    const input = new InputManager(fakeContainer());
    const seen: ActionState[] = [];
    input.onActionState((s) => seen.push(s));
    expect(seen.length).toBe(1); // estado inicial inmediato
    expect(seen[0].flying).toBe(false);

    const base = { canGrab: false, holding: false, grounded: false, canDoubleJump: false };
    input.setActionState({ ...base, flying: true });
    expect(seen.length).toBe(2);
    expect(seen[1].flying).toBe(true);

    // Sin cambios → no notifica (anti-spam del HUD).
    input.setActionState({ ...base, flying: true });
    expect(seen.length).toBe(2);

    input.setActionState({ ...base, flying: false });
    expect(seen.length).toBe(3);
    expect(seen[2].flying).toBe(false);
    input.dispose();
  });
});
