import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CharacterController, type Island } from "@phygitalia/engine";

/**
 * [EQUIPO COLLIDER] CharacterController.addCylinderCollider() — postes sólidos
 * estáticos (el tótem de Paqo). Verifica:
 *  - Empuja fuera: caminar contra el cilindro deja la XZ final EN EL BORDE (nunca
 *    dentro del radio efectivo).
 *  - Resbala tangencialmente: caminar en oblicuo contra el borde NO frena en seco —
 *    conserva la componente tangencial y avanza a lo largo del cilindro.
 *  - El vuelo también respeta el collider (por debajo de topY).
 *  - Saltar/volar por ENCIMA de topY pasa libre.
 *  - Caso degenerado centro==posición: empuja a una dirección estable (+X), sin NaN.
 *  - Sin colliders: todo igual (el avatar atraviesa la zona sin obstáculo).
 *
 * Igual que fly-controller.test.ts: el controller toca THREE + blob-shadow (canvas
 * 2D) → mockeamos un canvas mínimo y una isla plana falsa (sólo su `field`).
 */

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.document === "undefined") {
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

function makeController(spawn = new THREE.Vector3(5, 0, 0)): CharacterController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new CharacterController(flatIsland(), spawn, fakeRig() as any);
}

function walkIntent(dir: THREE.Vector3) {
  return {
    worldDir: dir.clone().normalize(),
    throttle: 1,
    run: false,
    jump: false,
  };
}

function stepFrames(c: CharacterController, n: number, intent: ReturnType<typeof walkIntent>): void {
  for (let i = 0; i < n; i++) c.update(1 / 60, { ...intent });
}

/** Radio del cuerpo del avatar sumado al del cilindro (AVATAR_RADIUS del controller). */
const AVATAR_RADIUS = 0.45;
/** Cilindro de prueba: radio 2 u en el origen, tapa MUY alta (siempre bloquea a ras). */
const TALL = { x: 0, z: 0, radius: 2, topY: 100 };
/** Distancia mínima efectiva centro→avatar (radio + cuerpo). */
const MIN_DIST = TALL.radius + AVATAR_RADIUS;

function hxz(c: CharacterController): number {
  return Math.hypot(c.position.x, c.position.z);
}

describe("CharacterController — collider cilíndrico (empuja fuera)", () => {
  it("caminar de frente contra el cilindro deja la XZ EN EL BORDE, nunca dentro", () => {
    const c = makeController(new THREE.Vector3(5, 0, 0));
    c.addCylinderCollider(TALL);

    // Camina hacia el centro (−X) durante 2 s: choca y queda pegado al borde.
    stepFrames(c, 120, walkIntent(new THREE.Vector3(-1, 0, 0)));

    // Nunca penetró: la distancia final es ≥ MIN_DIST (borde), y ≈ MIN_DIST (llegó).
    expect(hxz(c)).toBeGreaterThanOrEqual(MIN_DIST - 1e-6);
    expect(hxz(c)).toBeCloseTo(MIN_DIST, 2);
    // No tuneló al otro lado: se quedó en el lado +X desde el que llegó.
    expect(c.position.x).toBeGreaterThan(0);
    // Sigue a ras de suelo (el collider no afecta la vertical).
    expect(c.feetY).toBeCloseTo(0, 3);
  });

  it("en NINGÚN frame la posición entra dentro del radio efectivo", () => {
    const c = makeController(new THREE.Vector3(4, 0, 0));
    c.addCylinderCollider(TALL);
    const intent = walkIntent(new THREE.Vector3(-1, 0, 0));
    for (let i = 0; i < 120; i++) {
      c.update(1 / 60, { ...intent });
      expect(hxz(c)).toBeGreaterThanOrEqual(MIN_DIST - 1e-6);
    }
  });
});

describe("CharacterController — collider cilíndrico (resbalón tangencial)", () => {
  it("caminar en oblicuo contra el borde resbala (avanza) y NO frena en seco", () => {
    // Arranca pegado al borde (+X) y empuja en oblicuo: hacia el centro (−X) y a lo
    // largo del cilindro (+Z). La componente hacia el centro muere; la tangencial vive.
    const c = makeController(new THREE.Vector3(MIN_DIST, 0, 0));
    c.addCylinderCollider(TALL);
    const z0 = c.position.z;

    stepFrames(c, 60, walkIntent(new THREE.Vector3(-1, 0, 1)));

    // Se deslizó de verdad a lo largo del cilindro (no quedó clavado en el punto).
    expect(c.position.z).toBeGreaterThan(z0 + 1);
    // Y no se detuvo en seco: conserva velocidad tangencial apreciable.
    expect(c.getHorizVelocity().length()).toBeGreaterThan(1.5);
    // Nunca penetró: resbala SOBRE/afuera de la superficie del cilindro (el push-out
    // sólo empuja hacia afuera, nunca tira hacia adentro; deslizarse por la tangente
    // de un borde curvo aleja un pelín, que es justo el feel de "resbalar y salir").
    expect(hxz(c)).toBeGreaterThanOrEqual(MIN_DIST - 1e-6);
  });

  it("empujarse HACIA AFUERA no se penaliza (la velocidad de salida se conserva)", () => {
    const c = makeController(new THREE.Vector3(MIN_DIST, 0, 0));
    c.addCylinderCollider(TALL);
    // Dirección puramente radial hacia afuera (+X): debe alejarse sin freno.
    stepFrames(c, 30, walkIntent(new THREE.Vector3(1, 0, 0)));
    expect(c.position.x).toBeGreaterThan(MIN_DIST + 1);
  });
});

describe("CharacterController — collider cilíndrico (vertical / vuelo)", () => {
  it("el vuelo también respeta el collider por debajo de topY", () => {
    const c = makeController(new THREE.Vector3(5, 0, 0));
    c.addCylinderCollider(TALL); // topY=100: el liftoff (~6 u) queda muy por debajo
    c.toggleFly();

    // Vuela hacia el centro con mirada horizontal: el push-out lo frena en el borde.
    const flyIn = {
      worldDir: new THREE.Vector3(-1, 0, 0),
      throttle: 1,
      run: false,
      jump: false,
      lookDir: new THREE.Vector3(-1, 0, 0),
    };
    for (let i = 0; i < 120; i++) {
      c.update(1 / 60, { ...flyIn });
      expect(hxz(c)).toBeGreaterThanOrEqual(MIN_DIST - 1e-6);
    }
    expect(c.isFlying()).toBe(true);
    expect(c.position.x).toBeGreaterThan(0);
  });

  it("volar por ENCIMA de topY pasa libre (no colisiona)", () => {
    // Tapa baja (0.5 u): en cuanto los pies la superan, el cilindro deja de bloquear.
    const c = makeController(new THREE.Vector3(5, 0, 0));
    c.addCylinderCollider({ x: 0, z: 0, radius: 2, topY: 0.5 });
    c.toggleFly(); // despega ~6 u: pies MUY por encima de 0.5

    const flyIn = {
      worldDir: new THREE.Vector3(-1, 0, 0),
      throttle: 1,
      run: false,
      jump: false,
      lookDir: new THREE.Vector3(-1, 0, 0),
    };
    stepFrames(c, 180, flyIn as never);

    // Cruzó por encima del tótem: llegó al otro lado (x negativa), sin bloqueo.
    expect(c.feetY).toBeGreaterThan(0.5);
    expect(c.position.x).toBeLessThan(0);
  });
});

describe("CharacterController — collider cilíndrico (casos límite)", () => {
  it("centro==posición: empuja a dirección estable (+X), sin NaN", () => {
    const c = makeController(new THREE.Vector3(0, 0, 0)); // EXACTAMENTE en el eje
    c.addCylinderCollider(TALL);
    c.update(1 / 60, walkIntent(new THREE.Vector3(0, 0, 0)));

    expect(Number.isFinite(c.position.x)).toBe(true);
    expect(Number.isFinite(c.position.z)).toBe(true);
    // Expulsado al borde en +X (dirección determinista del caso degenerado).
    expect(c.position.x).toBeCloseTo(MIN_DIST, 5);
    expect(c.position.z).toBeCloseTo(0, 5);
  });
});

describe("CharacterController — SIN colliders todo igual", () => {
  it("sin registrar collider, el avatar atraviesa la zona del tótem sin obstáculo", () => {
    const c = makeController(new THREE.Vector3(5, 0, 0));
    // NO se registra ningún collider.
    stepFrames(c, 180, walkIntent(new THREE.Vector3(-1, 0, 0)));

    // Camina en línea recta y pasa DE LARGO por donde estaría el tótem (x < 0).
    expect(c.position.x).toBeLessThan(0);
    expect(c.feetY).toBeCloseTo(0, 3);
  });

  it("un collider registrado NO altera el movimiento lejos de él", () => {
    // Con collider en el origen, pero caminando por fuera de su alcance: idéntico a
    // no tenerlo (mismo desplazamiento que el avatar libre).
    const withC = makeController(new THREE.Vector3(20, 0, 20));
    withC.addCylinderCollider(TALL);
    const free = makeController(new THREE.Vector3(20, 0, 20));

    const intent = walkIntent(new THREE.Vector3(1, 0, 0)); // se aleja del origen
    stepFrames(withC, 60, intent);
    stepFrames(free, 60, intent);

    expect(withC.position.x).toBeCloseTo(free.position.x, 6);
    expect(withC.position.z).toBeCloseTo(free.position.z, 6);
  });
});
