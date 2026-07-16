import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CharacterController, type Island } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO] CharacterController.toggleFly() — botón "Volar" / tecla Q.
 * Entrada ALTERNATIVA al triple salto (que se conserva). Verifica:
 *  - toggleFly() entra a vuelo desde el suelo y NO re-aterriza (despegue).
 *  - El DESPEGUE desde el suelo eleva ≥5 u y ≤8 u (por debajo de los 8.5 u de Paqo),
 *    con ease-out, sin congelar el movimiento horizontal, y entrega al vuelo normal.
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

/** Referencia DURA de Julio: el tótem de Paqo mide 8.5 u (`world/Totem.ts`). */
const PAQO_HEIGHT = 8.5;
/** Altura del rig de test (`fakeRig`): pies + esto = coronilla del avatar. */
const AVATAR_HEIGHT = 1.8;
/** Duración holgada del despegue (la curva tarda ~1.2 s): 2 s en frames de 1/60. */
const LIFTOFF_FRAMES = 120;

/** Intento de vuelo con mirada: avanza hacia -Z mirando con el pitch dado. */
function flyIntent(pitchY: number) {
  return {
    worldDir: new THREE.Vector3(0, 0, -1),
    throttle: 1,
    run: false,
    jump: false,
    lookDir: new THREE.Vector3(0, pitchY, -1).normalize(),
  };
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

/**
 * DESPEGUE (liftoff): activar el vuelo EN EL SUELO eleva de forma clara — "que sí se
 * sienta que está volando" — pero sin sobrepasar a Paqo (8.5 u). Constantes del
 * controller: LIFTOFF_RISE = 6 u, LIFTOFF_MAX_ABS = 8 u (tope duro).
 */
describe("CharacterController — despegue al activar el vuelo desde el suelo", () => {
  it("eleva ≥5 u y ≤8 u sobre el suelo, sin sobrepasar la altura de Paqo", () => {
    const c = makeController();
    expect(c.feetY).toBeCloseTo(0, 5);

    c.toggleFly();
    let peak = c.feetY;
    for (let i = 0; i < LIFTOFF_FRAMES; i++) {
      c.update(1 / 60, { ...IDLE });
      peak = Math.max(peak, c.feetY);
    }

    // Elevación clara (se siente vuelo) pero acotada: nunca por encima de 8 u.
    // MEDIDO: pies pico 6.054 u → coronilla 7.854 u, bajo los 8.5 u de Paqo.
    expect(c.feetY).toBeGreaterThanOrEqual(5);
    expect(peak).toBeLessThanOrEqual(8);
    // Y la coronilla queda POR DEBAJO de la cabeza de Paqo (referencia de Julio).
    expect(peak + AVATAR_HEIGHT).toBeLessThan(PAQO_HEIGHT);
  });

  it("no re-aterriza: sube monótono y cruza el umbral de aterrizaje al instante", () => {
    const c = makeController();
    c.toggleFly();

    // §4 re-posa si los pies quedan ≤0.35 sobre el suelo Y vertVel≤0. La curva
    // mantiene vertVel>0 todo el despegue (nunca re-posa), y a 10 u/s cruza esos
    // 0.35 u en ~3 frames (~0.05 s): imperceptible.
    let prev = c.feetY;
    for (let i = 0; i < 3; i++) {
      c.update(1 / 60, { ...IDLE });
      expect(c.feetY).toBeGreaterThan(prev); // sube en TODOS los frames, sin recaída
      expect(c.isGrounded()).toBe(false);
      expect(c.isFlying()).toBe(true);
      prev = c.feetY;
    }
    expect(c.feetY).toBeGreaterThan(0.35);

    // Y en ningún frame del resto del despegue vuelve a tocar suelo ni pierde el vuelo.
    for (let i = 0; i < LIFTOFF_FRAMES; i++) {
      c.update(1 / 60, { ...IDLE });
      expect(c.isGrounded()).toBe(false);
      expect(c.isFlying()).toBe(true);
    }
  });

  it("sube con ease-out: rápido al inicio, se demora al llegar", () => {
    const c = makeController();
    c.toggleFly();

    stepFrames(c, 36); // ~0.6 s: media duración de la curva (~1.2 s)
    const half = c.feetY;
    stepFrames(c, LIFTOFF_FRAMES);
    const total = c.feetY;

    // A media duración ya lleva la mayor parte del recorrido (curva decelerada).
    expect(half).toBeGreaterThan(0.6 * total);
    expect(half).toBeLessThan(total);
  });

  it("entrega al vuelo normal: la altura se estabiliza (sólo flota, ya no sube)", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, LIFTOFF_FRAMES);
    const settled = c.feetY;

    // Otros 2 s de vuelo idle: sólo la flotación sutil (±0.07 u), sin deriva.
    stepFrames(c, 120);
    expect(Math.abs(c.feetY - settled)).toBeLessThan(0.2);
    expect(c.isFlying()).toBe(true);
  });

  it("el tope de 8 u es SÓLO del despegue: mirando arriba se sigue subiendo", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, LIFTOFF_FRAMES);
    const afterLiftoff = c.feetY;

    // Mirar arriba y avanzar durante 2 s: rebasa el tope del despegue y a Paqo.
    stepFrames(c, 120, flyIntent(1));
    expect(c.feetY).toBeGreaterThan(afterLiftoff + 3);
    expect(c.feetY).toBeGreaterThan(PAQO_HEIGHT);
  });

  it("durante el despegue el jugador conserva el control horizontal", () => {
    const c = makeController();
    const z0 = c.position.z;
    c.toggleFly();

    // Mirada horizontal: avanza hacia -Z mientras la curva lo eleva.
    stepFrames(c, LIFTOFF_FRAMES, flyIntent(0));
    expect(c.position.z).toBeLessThan(z0 - 5); // se desplazó de verdad
    expect(c.feetY).toBeGreaterThanOrEqual(5); // y aun así despegó
    expect(c.feetY).toBeLessThanOrEqual(8);
  });

  it("salir del vuelo tras el despegue cae con normalidad y aterriza", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, LIFTOFF_FRAMES);
    expect(c.feetY).toBeGreaterThanOrEqual(5);

    c.toggleFly(); // Q otra vez → caer
    expect(c.isFlying()).toBe(false);

    stepFrames(c, 120); // 2 s: desde ~6 u con gravedad 22 sobra
    expect(c.isGrounded()).toBe(true);
    expect(c.feetY).toBeCloseTo(0, 1);
  });

  it("salir del vuelo EN MEDIO del despegue también cae y aterriza", () => {
    const c = makeController();
    c.toggleFly();
    stepFrames(c, 20); // despegue a medias
    expect(c.feetY).toBeGreaterThan(0.35);

    c.update(1 / 60, { ...IDLE, jump: true }); // salto-en-vuelo = caer
    expect(c.isFlying()).toBe(false);

    stepFrames(c, 120);
    expect(c.isGrounded()).toBe(true);
    expect(c.feetY).toBeCloseTo(0, 1);
  });

  it("activar el vuelo EN EL AIRE no hace despegue: sólo estabiliza la altura", () => {
    const c = makeController();
    // Salto normal: a los ~0.25 s va subiendo, bien despegado del suelo.
    c.update(1 / 60, { ...IDLE, jump: true });
    stepFrames(c, 15);
    expect(c.isGrounded()).toBe(false);
    const airY = c.feetY;

    c.setFlying(true); // Q en el aire → conserva su altura, sin subida automática
    stepFrames(c, LIFTOFF_FRAMES);
    expect(c.isFlying()).toBe(true);
    // Se queda donde estaba (sólo flota ±0.07 u): NADA de los 6 u del despegue.
    expect(Math.abs(c.feetY - airY)).toBeLessThan(0.2);
  });
});
