import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CharacterController, type Island } from "@phygitalia/engine";

/**
 * [EQUIPO MOVIMIENTO] CharacterController.toggleFly() — botón "Volar" / tecla Q.
 * Entrada ALTERNATIVA al triple salto (que se conserva). Verifica:
 *  - toggleFly() entra a vuelo desde el suelo y NO re-aterriza (despegue).
 *  - En vuelo idle sigue volando frame a frame (flotación sutil, sin caer).
 *  - toggleFly() de nuevo SALE del vuelo → cae y vuelve a tocar suelo.
 *  - Pulsar salto EN vuelo también sale (se conserva "salto-en-vuelo = caer").
 *
 * El controller toca THREE (mallas) y el blob-shadow usa un canvas 2D: en node
 * mockeamos un canvas mínimo y una isla plana falsa (sólo su `field`).
 */

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.document === "undefined") {
    // Canvas mínimo para makeSoftCircleTexture (blob-shadow del controller).
    const ctx = {
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      fillStyle: "",
    };
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
    };
  }
});

/** Isla PLANA falsa: suelo en y=0, siempre dentro, normal hacia arriba. */
function flatIsland(): Island {
  const field = {
    clearLevel: 0,
    heightAt: () => 0,
    insideIsland: () => true,
    surfaceNormal: (_x: number, _z: number, out: THREE.Vector3) => out.set(0, 1, 0),
    surfacePoint: (x: number, _z: number, out: THREE.Vector3) => out.set(x, 0, _z),
  };
  return { field } as unknown as Island;
}

/** Rig falso mínimo (evita construir la cápsula placeholder con canvas/outline). */
function fakeRig() {
  return {
    root: new THREE.Group(),
    height: 1.8,
    update: () => {},
    playEmote: () => {},
    setTint: () => {},
    attachProp: () => {},
    dispose: () => {},
  };
}

function makeController(): CharacterController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0), fakeRig() as any);
}

const IDLE = { worldDir: new THREE.Vector3(0, 0, 0), throttle: 0, run: false, jump: false };

function stepFrames(c: CharacterController, n: number, intent = IDLE): void {
  for (let i = 0; i < n; i++) c.update(1 / 60, { ...intent });
}

describe("CharacterController — toggleFly", () => {
  it("entra a vuelo desde el suelo y se mantiene volando (despegue, no re-aterriza)", () => {
    const c = makeController();
    expect(c.isFlying()).toBe(false);
    expect(c.isGrounded()).toBe(true);

    c.toggleFly();
    expect(c.isFlying()).toBe(true);

    // Tras medio segundo de vuelo idle sigue volando y se separó del suelo.
    stepFrames(c, 40);
    expect(c.isFlying()).toBe(true);
    expect(c.isGrounded()).toBe(false);
    expect(c.feetY).toBeGreaterThan(0.35); // clearó el umbral de aterrizaje
  });

  it("segundo toggleFly() SALE del vuelo → cae y vuelve a tocar suelo", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, 40);
    expect(c.isFlying()).toBe(true);

    c.toggleFly();
    expect(c.isFlying()).toBe(false);

    // Sin gravedad-off, cae y aterriza en ~1 s.
    stepFrames(c, 90);
    expect(c.isFlying()).toBe(false);
    expect(c.isGrounded()).toBe(true);
    expect(c.feetY).toBeCloseTo(0, 1);
  });

  it("pulsar salto EN vuelo también sale (se conserva 'salto-en-vuelo = caer')", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, 20);
    expect(c.isFlying()).toBe(true);

    c.update(1 / 60, { ...IDLE, jump: true });
    expect(c.isFlying()).toBe(false);
  });

  it("setFlying(true/false) es idempotente y coincide con toggleFly", () => {
    const c = makeController();
    c.setFlying(false); // ya en suelo: no-op
    expect(c.isFlying()).toBe(false);
    c.setFlying(true);
    expect(c.isFlying()).toBe(true);
    c.setFlying(true); // repetir no rompe
    expect(c.isFlying()).toBe(true);
    c.setFlying(false);
    expect(c.isFlying()).toBe(false);
  });
});
