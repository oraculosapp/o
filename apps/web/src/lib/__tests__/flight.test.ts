import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CharacterController } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO/MANDOS] TRIPLE SALTO = VOLAR.
 *  - El TERCER salto activa el modo VUELO (gravedad off, flota con bob sutil).
 *  - Pulsar salto EN VUELO → cae (gravedad normal, sale del modo).
 *  - Aterrizar también sale del modo (y recarga los saltos).
 *  - Crucero ~9 u/s; la mirada (lookDir) inclina el vuelo (mirar arriba = subir).
 */

// El constructor crea la sombra de blob con un canvas 2D; en node lo mockeamos.
beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  if (typeof g.document === "undefined") {
    const ctx = {
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      fillStyle: "" as unknown,
    };
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  }
});

/** Isla plana (terreno a Y=0) para aislar la lógica de salto/vuelo. */
function flatIsland() {
  const field = {
    heightAt: () => 0,
    surfaceNormal: (_x: number, _z: number, out?: THREE.Vector3) =>
      (out ?? new THREE.Vector3()).set(0, 1, 0),
    surfacePoint: (x: number, z: number, out?: THREE.Vector3) =>
      (out ?? new THREE.Vector3()).set(x, 0, z),
    insideIsland: () => true,
    clearLevel: 0,
  };
  return { field } as never;
}

const idle = { worldDir: new THREE.Vector3(), throttle: 0, run: false, jump: false };
const DT = 1 / 60;

function steps(c: CharacterController, n: number, intent = idle): void {
  for (let i = 0; i < n; i++) c.update(DT, intent);
}

/** Encadena salto → doble salto → TERCER salto (con pulsaciones reales separadas). */
function tripleJump(c: CharacterController): void {
  c.update(DT, { ...idle, jump: true }); // 1er salto (suelo)
  steps(c, 8);
  c.update(DT, { ...idle, jump: true }); // doble salto (aire)
  steps(c, 8);
  c.update(DT, { ...idle, jump: true }); // TERCER salto → VUELO
}

describe("CharacterController — triple salto activa el VUELO", () => {
  it("tras el tercer salto isFlying()=true y flota sin caer (bob sutil)", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    expect(c.isFlying()).toBe(false);

    tripleJump(c);
    expect(c.isFlying()).toBe(true);
    expect(c.isGrounded()).toBe(false);
    // En vuelo ya no quedan saltos de aire: el botón pasa a "Caer".
    expect(c.canDoubleJump()).toBe(false);

    // Flotación idle 2 s: NO cae (sin gravedad); el bob senoidal es ±0.15 u.
    steps(c, 12); // transitorio corto: la velocidad vertical decae a 0
    const y0 = c.position.y;
    steps(c, 120);
    expect(c.isFlying()).toBe(true);
    expect(Math.abs(c.position.y - y0)).toBeLessThan(0.5);
    expect(c.position.y).toBeGreaterThan(1); // sigue en el aire, no en el suelo
  });

  it("un doble salto normal NO activa el vuelo", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    c.update(DT, { ...idle, jump: true });
    steps(c, 8);
    c.update(DT, { ...idle, jump: true }); // sólo doble salto
    expect(c.isFlying()).toBe(false);
    // Y sin más pulsaciones, acaba aterrizando por gravedad.
    steps(c, 400);
    expect(c.isGrounded()).toBe(true);
  });

  it("pulsar salto EN VUELO → cae con gravedad normal y sale del modo", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    tripleJump(c);
    steps(c, 30); // flota un rato
    expect(c.isFlying()).toBe(true);

    c.update(DT, { ...idle, jump: true }); // botón "Caer"
    expect(c.isFlying()).toBe(false);
    expect(c.isGrounded()).toBe(false); // aún en el aire, cayendo

    steps(c, 400); // la gravedad lo trae al suelo
    expect(c.isGrounded()).toBe(true);
    expect(c.isFlying()).toBe(false);
    // Al aterrizar se recargan los saltos (jumpsUsed=0 → sin doble salto pendiente).
    expect(c.canDoubleJump()).toBe(false);
  });

  it("aterrizar volando hacia abajo también sale del modo vuelo", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    tripleJump(c);
    expect(c.isFlying()).toBe(true);

    // Vuela en PICADA: mirada inclinada hacia abajo + avanzar (W).
    const dive = {
      worldDir: new THREE.Vector3(0, 0, -1),
      throttle: 1,
      run: false,
      jump: false,
      lookDir: new THREE.Vector3(0, -0.8, -0.6).normalize(),
    };
    steps(c, 300, dive);
    expect(c.isGrounded()).toBe(true);
    expect(c.isFlying()).toBe(false);
    expect(c.feetY).toBeCloseTo(0, 2); // posado en el terreno plano
  });

  it("crucero ~9 u/s con mirada horizontal (más rápido que correr)", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    tripleJump(c);

    const fwd = {
      worldDir: new THREE.Vector3(1, 0, 0),
      throttle: 1,
      run: false,
      jump: false,
      lookDir: new THREE.Vector3(1, 0, 0),
    };
    steps(c, 120, fwd); // 2 s: de sobra para alcanzar el crucero (accel 20)
    expect(c.isFlying()).toBe(true);
    const speed = c.getHorizVelocity(new THREE.Vector3()).length();
    expect(speed).toBeGreaterThan(8.5);
    expect(speed).toBeLessThan(9.5);
  });

  it("mirar ARRIBA y avanzar = ganar altura (la mirada inclina el vuelo)", () => {
    const c = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    tripleJump(c);
    steps(c, 12);
    const y0 = c.position.y;

    const climb = {
      worldDir: new THREE.Vector3(0, 0, -1),
      throttle: 1,
      run: false,
      jump: false,
      lookDir: new THREE.Vector3(0, 0.707, -0.707),
    };
    steps(c, 60, climb); // 1 s subiendo
    expect(c.isFlying()).toBe(true);
    expect(c.position.y).toBeGreaterThan(y0 + 2);
  });
});
