import { beforeAll, describe, expect, it } from "vitest";
import { InputManager } from "@phygitalia/engine";

/**
 * [EQUIPO FIX-MUNDO] InputManager — tecla PEGADA al perder el foco de la ventana.
 *
 * El porqué: si sales de la pestaña (Alt+Tab, cambio de app) con W pulsada, el
 * `keyup` se dispara en la OTRA ventana y nunca nos llega → la tecla se queda en
 * el Set para siempre y el avatar camina solo al volver. El fix escucha `blur` en
 * window y suelta todo el input mantenido; el listener se retira en dispose()
 * (simetría, si no el manager sobrevive al desmontaje colgado de window).
 *
 * En node no hay DOM: falsificamos window con un REGISTRO de listeners para poder
 * disparar el blur a mano y comprobar además que se retira.
 */

/** Registro de listeners de window (clave = tipo de evento). */
const winListeners = new Map<string, Set<(e: unknown) => void>>();

function fireWindow(type: string, ev: unknown): void {
  for (const cb of winListeners.get(type) ?? []) cb(ev);
}

function windowListenerCount(type: string): number {
  return winListeners.get(type)?.size ?? 0;
}

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
    g.window = {
      addEventListener: (type: string, cb: (e: unknown) => void) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: (e: unknown) => void) => {
        winListeners.get(type)?.delete(cb);
      },
    };
  }
  if (typeof g.getComputedStyle === "undefined") {
    g.getComputedStyle = () => ({ position: "relative" });
  }
});

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

/** Evento de teclado mínimo (el manager sólo mira `key`, `target` y preventDefault). */
function keyEvent(key: string): unknown {
  return { key, target: null, preventDefault: () => {} };
}

describe("InputManager — blur de ventana", () => {
  it("suelta la tecla de avance pulsada (no queda caminando solo)", () => {
    const input = new InputManager(fakeContainer());

    fireWindow("keydown", keyEvent("w"));
    expect(input.consumeMove().moveAxis.y).toBe(1);

    // Alt+Tab: el keyup nunca llega, sólo el blur.
    fireWindow("blur", {});
    expect(input.consumeMove().moveAxis.y).toBe(0);

    input.dispose();
  });

  it("descarta también correr y los edges encolados", () => {
    const input = new InputManager(fakeContainer());
    input.setRun(true);
    input.pressJump();
    input.pressFly();

    fireWindow("blur", {});

    const f = input.consumeMove();
    expect(f.run).toBe(false);
    expect(f.jump).toBe(false);
    expect(f.fly).toBe(false);

    input.dispose();
  });

  it("registra y retira el listener de blur (simetría de ciclo de vida)", () => {
    const before = windowListenerCount("blur");
    const input = new InputManager(fakeContainer());
    expect(windowListenerCount("blur")).toBe(before + 1);
    input.dispose();
    expect(windowListenerCount("blur")).toBe(before);
  });

  it("no revive el input al volver: hay que volver a pulsar", () => {
    const input = new InputManager(fakeContainer());
    fireWindow("keydown", keyEvent("d"));
    fireWindow("blur", {});
    expect(input.consumeMove().moveAxis.x).toBe(0);

    // Al volver y pulsar de nuevo, funciona con normalidad.
    fireWindow("keydown", keyEvent("d"));
    expect(input.consumeMove().moveAxis.x).toBe(1);
    input.dispose();
  });
});
