import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Balls, WorldNet } from "@phygitalia/engine";

/** Campo plano de prueba (altura 0, normal vertical, claro a nivel 1). */
const flatField = {
  heightAt: () => 0,
  surfaceNormal: (_x: number, _z: number, out?: THREE.Vector3) =>
    (out ?? new THREE.Vector3()).set(0, 1, 0),
  insideIsland: () => true,
  clearLevel: 1,
};

function xz(pos: [number, number, number]): number {
  return Math.hypot(pos[0], pos[2]);
}

describe("Balls — regla de zona central (respawn instantáneo)", () => {
  it("build() esparce 9 pelotas DENTRO de la zona (r ≤ 18)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    expect(balls.count).toBe(9);
    for (let i = 0; i < balls.count; i++) {
      expect(xz(balls.stateOf(i).pos)).toBeLessThanOrEqual(18);
    }
  });

  it("applyState con posición FUERA de zona hace snap al slot casa (no lerp hacia fuera)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const homeR = xz(balls.stateOf(0).pos);
    balls.applyState(0, { pos: [30, 0, 0], vel: [0, 0, 0] });
    const after = balls.stateOf(0).pos;
    expect(xz(after)).toBeLessThan(18); // volvió a la zona
    expect(xz(after)).toBeCloseTo(homeR, 5); // exactamente su slot casa determinista
    expect(balls.isLiveByLocal(0)).toBe(false);
  });

  it("respawnToHome teleporta a casa, limpia la atribución local y emite onRespawn", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const seen: Array<{ id: number; reason: string }> = [];
    balls.onRespawn((id, _s, reason) => seen.push({ id, reason }));
    balls.respawnToHome(3, "hit");
    expect(balls.isLiveByLocal(3)).toBe(false);
    expect(xz(balls.stateOf(3).pos)).toBeLessThan(18);
    expect(seen).toContainEqual({ id: 3, reason: "hit" });
  });

  it("una pelota lanzada que sale de la zona respawnea (reason 'out') en el update", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const respawns: Array<{ id: number; reason: string }> = [];
    balls.onRespawn((id, _s, reason) => respawns.push({ id, reason }));

    // Lánzala con una velocidad ENORME hacia +X (hereda 0.5·playerVel).
    expect(balls.grab(0)).toBe(true);
    balls.throwBall(new THREE.Vector3(1, 0, 0), new THREE.Vector3(400, 0, 0));
    expect(balls.isLiveByLocal(0)).toBe(true);

    // Unos frames: sale volando de r>18 y la zona la repone a casa.
    const far = new THREE.Vector3(0, -100, 0); // jugador lejos: no la vuelve a patear
    const noVel = new THREE.Vector3();
    for (let i = 0; i < 4; i++) balls.update(0.1, far, noVel);

    expect(respawns.some((r) => r.id === 0 && r.reason === "out")).toBe(true);
    expect(balls.isLiveByLocal(0)).toBe(false);
    expect(xz(balls.stateOf(0).pos)).toBeLessThan(18);
  });

  it("throwBall atribuye la pelota al local y emite onThrow (la patada NO emite onThrow)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const thrown: number[] = [];
    balls.onThrow((id) => thrown.push(id));
    balls.grab(2);
    balls.throwBall(new THREE.Vector3(0, 0, -1), new THREE.Vector3());
    expect(thrown).toContain(2);
    expect(balls.isLiveByLocal(2)).toBe(true);
  });
});

describe("Balls — atribución por PATADA del jugador local", () => {
  it("caminar contra una pelota (tryKick) la atribuye al local para puntuar", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    // La pelota 0 en su slot casa: llevamos al jugador local justo encima, moviéndose.
    const home = balls.stateOf(0).pos; // [x, 0.35, z] sobre suelo plano
    const player = new THREE.Vector3(home[0], 1.0, home[2]);
    const vel = new THREE.Vector3(3, 0, 0); // caminando hacia +X
    // feetY=0: rel = ballY(0.35) − 0 dentro de la ventana vertical de patada.
    balls.update(0.016, player, vel, 0);
    expect(balls.isLiveByLocal(0)).toBe(true);
  });

  it("la atribución por patada expira si nadie local la vuelve a tocar", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    // Patea la 0 y luego mándala fuera de contacto: la fricción la duerme y/o la
    // ventana de atribución vence → deja de contar como movida por mí.
    const home = balls.stateOf(0).pos;
    const player = new THREE.Vector3(home[0], 1.0, home[2]);
    balls.update(0.016, player, new THREE.Vector3(3, 0, 0), 0);
    expect(balls.isLiveByLocal(0)).toBe(true);
    const far = new THREE.Vector3(0, -100, 0); // jugador lejos: sin nuevos contactos
    const noVel = new THREE.Vector3();
    for (let i = 0; i < 60; i++) balls.update(0.1, far, noVel); // ~6 s
    expect(balls.isLiveByLocal(0)).toBe(false);
  });
});

/**
 * FIX-RED #1 — la atribución local (`liveBy`, ventana de 4 s) NUNCA se revocaba
 * cuando un REMOTO tocaba la pelota: ni las ramas SNAP/lerp de applyState ni
 * applyGrab (que retornaba antes) la limpiaban. Consecuencia en producción: dos
 * clientes puntuaban el MISMO impacto y uno podía puntuar con una pelota que otro
 * llevaba en las manos (doble respawn con teleport visible).
 */
describe("Balls — un toque REMOTO revoca la autoría local", () => {
  /** Lanza la pelota 0 y devuelve el sistema con la atribución local viva. */
  function thrownBalls(): Balls {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("me");
    balls.grab(0);
    balls.throwBall(new THREE.Vector3(0, 0, -1), new THREE.Vector3());
    expect(balls.isLiveByLocal(0)).toBe(true);
    return balls;
  }

  it("rama LERP (ajuste pequeño): un paquete 'ball' ajeno revoca la autoría", () => {
    const balls = thrownBalls();
    const p = balls.stateOf(0).pos;
    balls.applyState(0, { pos: [p[0] + 0.4, p[1], p[2]], vel: [0, 0, 0] });
    expect(balls.isLiveByLocal(0)).toBe(false);
  });

  it("rama SNAP (salto grande en zona): un paquete 'ball' ajeno revoca la autoría", () => {
    const balls = thrownBalls();
    balls.applyState(0, { pos: [10, 1.15, 0], vel: [0, 0, 0] });
    expect(balls.isLiveByLocal(0)).toBe(false);
  });

  it("rama FUERA DE ZONA: sigue revocando la autoría (no había regresión)", () => {
    const balls = thrownBalls();
    balls.applyState(0, { pos: [30, 1, 0], vel: [0, 0, 0] });
    expect(balls.isLiveByLocal(0)).toBe(false);
  });

  it("un 'ball_grab' ajeno revoca la autoría AUNQUE yo no lleve ese balón", () => {
    const balls = thrownBalls();
    expect(balls.isHolding()).toBe(false); // la lancé: no la llevo
    balls.applyGrab(0, "thief", Date.now());
    expect(balls.isLiveByLocal(0)).toBe(false);
  });

  it("el 'ball_grab' ajeno no toca la autoría de OTRAS pelotas", () => {
    const balls = thrownBalls();
    balls.grab(1);
    balls.throwBall(new THREE.Vector3(0, 0, -1), new THREE.Vector3());
    balls.applyGrab(0, "thief", Date.now());
    expect(balls.isLiveByLocal(0)).toBe(false);
    expect(balls.isLiveByLocal(1)).toBe(true);
  });
});

/**
 * FIX-RED #2 — applyState no validaba nada: un `pos` con NaN mataba la pelota PARA
 * SIEMPRE (todas las guardas de zona/sueño comparan con NaN → false: ni respawnea,
 * ni se puede agarrar, ni se ve). La guarda vive en el engine además de en la capa
 * de red, porque el engine también corre sin red (QA, single-player, tests).
 */
describe("Balls — applyState rechaza paquetes de red envenenados", () => {
  const POISON: Array<[string, unknown]> = [
    ["NaN", [Number.NaN, 0, 0]],
    ["Infinity", [0, Number.POSITIVE_INFINITY, 0]],
    ["null dentro de la terna", [0, null, 0]],
    ["string dentro de la terna", ["7", 0, 0]],
    ["terna corta", [0, 0]],
    ["no es array", { x: 0, y: 0, z: 0 }],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [label, pos] of POISON) {
    it(`pos ${label} se ignora y la pelota sigue VIVA`, () => {
      const balls = new Balls(flatField as never);
      balls.build();
      const before = balls.stateOf(0).pos;
      balls.applyState(0, { pos, vel: [0, 0, 0] } as never);
      const after = balls.stateOf(0).pos;
      expect(after.every(Number.isFinite)).toBe(true);
      expect(after).toEqual(before);
      // Y sigue siendo agarrable/respawneable (no quedó fuera del mundo).
      expect(balls.canGrab(before[0], before[2])).toBe(true);
    });
  }

  it("una vel envenenada también se ignora (la pos no se toca)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const before = balls.stateOf(0).pos;
    balls.applyState(0, { pos: [7, 0.35, 0], vel: [Number.NaN, 0, 0] } as never);
    expect(balls.stateOf(0).pos).toEqual(before);
  });

  it("un id inválido (fuera de rango, no entero, string) no rompe ni toca nada", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const snapshot = Array.from({ length: balls.count }, (_, i) => balls.stateOf(i).pos);
    for (const bad of [-1, 9, 1.5, Number.NaN, "0" as never]) {
      expect(() => balls.applyState(bad as number, { pos: [7, 1, 0], vel: [0, 0, 0] })).not.toThrow();
    }
    for (let i = 0; i < balls.count; i++) expect(balls.stateOf(i).pos).toEqual(snapshot[i]);
  });

  it("tras un paquete envenenado, uno SANO sigue reconciliando con normalidad", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.applyState(0, { pos: [Number.NaN, 0, 0], vel: [0, 0, 0] });
    balls.applyState(0, { pos: [7, 0.35, 0], vel: [0, 0, 0] }); // salto grande → snap
    expect(xz(balls.stateOf(0).pos)).toBeCloseTo(7, 5);
  });
});

/**
 * FIX-RED #4 — doble portador irrecuperable: la propiedad del balón sólo viajaba en
 * el evento ÚNICO "ball_grab" (fire-and-forget). Si se perdía, A y B lo llevaban
 * para siempre (cada uno ignoraba el flujo "ball" del otro). Ahora el portador
 * adjunta heldBy/grabT en su paquete "ball" y el receptor se auto-cura en ≤100 ms.
 * COMPATIBILIDAD: los campos son opcionales; sin ellos el comportamiento es el viejo.
 */
describe("Balls — auto-cura del doble portador por el flujo 'ball'", () => {
  function holding(localId = "victim"): Balls {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId(localId);
    expect(balls.grab(0)).toBe(true);
    return balls;
  }

  it("el portador ADJUNTA heldBy/grabT al estado del balón que lleva", () => {
    const balls = holding("me");
    const s = balls.stateOf(0);
    expect(s.heldBy).toBe("me");
    expect(typeof s.grabT).toBe("number");
    // Las que NO llevo viajan limpias (paquete idéntico al de siempre).
    expect(balls.stateOf(1).heldBy).toBeUndefined();
    expect(balls.stateOf(1).grabT).toBeUndefined();
  });

  /** Mano del ladrón: lejos del slot casa de la 0 (r=4) → cae en la rama SNAP. */
  const THIEF_HAND: [number, number, number] = [12, 1.15, 0];

  it("un paquete 'ball' de un portador que GANA el desempate me lo quita y se aplica", () => {
    const balls = holding();
    balls.applyState(0, {
      pos: THIEF_HAND,
      vel: [0, 0, 0],
      heldBy: "thief",
      grabT: Date.now() + 1_000_000,
    });
    expect(balls.isHolding()).toBe(false);
    expect(balls.heldBall()).toBe(-1);
    // Y el estado del ladrón se adoptó (snap por salto grande): ya no queda en mi mano.
    expect(xz(balls.stateOf(0).pos)).toBeCloseTo(12, 5);
  });

  it("un portador que PIERDE el desempate (grabT viejo) no me roba nada", () => {
    const balls = holding();
    const mine = balls.stateOf(0).pos;
    balls.applyState(0, { pos: THIEF_HAND, vel: [0, 0, 0], heldBy: "thief", grabT: 1 });
    expect(balls.isHolding()).toBe(true);
    expect(balls.stateOf(0).pos).toEqual(mine); // su paquete se descartó entero
  });

  it("COMPAT: un paquete SIN heldBy/grabT (cliente viejo) se ignora como siempre", () => {
    const balls = holding();
    const mine = balls.stateOf(0).pos;
    balls.applyState(0, { pos: THIEF_HAND, vel: [0, 0, 0] });
    expect(balls.isHolding()).toBe(true);
    expect(balls.stateOf(0).pos).toEqual(mine);
  });

  it("COMPAT: un grabT no finito no dispara la auto-cura (paquete corrupto)", () => {
    const balls = holding();
    const mine = balls.stateOf(0).pos;
    balls.applyState(0, {
      pos: THIEF_HAND,
      vel: [0, 0, 0],
      heldBy: "thief",
      grabT: Number.NaN,
    });
    expect(balls.isHolding()).toBe(true);
    expect(balls.stateOf(0).pos).toEqual(mine);
  });

  it("el eco de mi PROPIO heldBy nunca me quita el balón", () => {
    const balls = holding("me");
    balls.applyState(0, {
      pos: THIEF_HAND,
      vel: [0, 0, 0],
      heldBy: "me",
      grabT: Date.now() + 1_000_000,
    });
    expect(balls.isHolding()).toBe(true);
  });
});

/**
 * RELOJES (S20) — `heldGrabT` (la autoridad del desempate de robos) salía de
 * `Date.now()`: el reloj del DISPOSITIVO. Ahora sale de un reloj INYECTABLE que la
 * capa de red rellena con su `serverNow` (Date.now + offset del servidor). Aquí, la
 * inyección en sí; los escenarios de dos clientes desfasados, en clock-skew.test.ts.
 */
describe("Balls — reloj inyectable de los timestamps de red", () => {
  it("por defecto (sin inyectar) sella los agarres con Date.now()", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_234_000);
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("me");
    balls.grab(0);
    expect(balls.stateOf(0).grabT).toBe(1_234_000);
    vi.useRealTimers();
  });

  it("el reloj del CONSTRUCTOR gobierna grabT y el `t` de onGrab", () => {
    const balls = new Balls(flatField as never, () => 777_000);
    balls.build();
    balls.setLocalId("me");
    const ts: number[] = [];
    balls.onGrab((_id, t) => ts.push(t));
    balls.grab(0);
    expect(ts).toEqual([777_000]);
    expect(balls.stateOf(0).grabT).toBe(777_000);
  });

  it("setNow() (lo llama la red al derivar el offset) reemplaza el reloj en caliente", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("me");
    let serverNow = 500_000;
    balls.setNow(() => serverNow);
    balls.grab(0);
    expect(balls.stateOf(0).grabT).toBe(500_000);
    // Se inyecta una FUNCIÓN: un offset que se derive más tarde se aplica solo.
    serverNow = 900_000;
    balls.throwBall(new THREE.Vector3(0, 0, -1), new THREE.Vector3());
    balls.grab(1);
    expect(balls.stateOf(1).grabT).toBe(900_000);
  });

  it("DEGRADACIÓN: un reloj inválido no rompe nada (se queda con el anterior)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_242_000);
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("me");
    balls.setNow(undefined as never);
    balls.grab(0);
    expect(balls.stateOf(0).grabT).toBe(4_242_000); // Date.now, como siempre
    vi.useRealTimers();
  });
});

/**
 * FIX-RED #6 (lado Balls) — `deflect` dejaba la pelota EXACTAMENTE en `radius`, y el
 * test de impacto del mini-juego es inclusivo (<=): tangente a la base de Paqo,
 * volvía a "golpear" cada frame. Ahora sale con epsilon, estrictamente fuera.
 */
describe("Balls — deflect expulsa ESTRICTAMENTE fuera del cilindro", () => {
  it("tras el rebote, la distancia al eje es > radio (no tangente)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const radius = 2;
    // Colócala pegada al eje del cilindro y empújala hacia dentro.
    balls.applyState(0, { pos: [1.2, 1, 0], vel: [-3, 0, 0] });
    balls.deflect(0, 0, 0, radius, 0.5);
    const p = balls.stateOf(0).pos;
    expect(Math.hypot(p[0], p[2])).toBeGreaterThan(radius);
  });
});

/** FIX-RED #7 (menores) — limpieza de escena e idempotencia del arranque. */
describe("Balls / WorldNet — limpieza e idempotencia", () => {
  it("dispose() saca la malla de pelotas de la escena", () => {
    const scene = new THREE.Scene();
    const balls = new Balls(flatField as never);
    balls.build();
    balls.addTo(scene);
    expect(scene.getObjectByName("net-balls")).toBeTruthy();
    balls.dispose();
    expect(scene.getObjectByName("net-balls")).toBeFalsy();
  });

  it("WorldNet.start() es idempotente (no duplica las 9 pelotas ni la malla)", () => {
    const scene = new THREE.Scene();
    const net = new WorldNet({
      scene,
      camera: new THREE.PerspectiveCamera(),
      playerPosition: new THREE.Vector3(),
      playerForward: (out?: THREE.Vector3) => (out ?? new THREE.Vector3()).set(0, 0, -1),
      playerGrounded: () => true,
      field: flatField as never,
    });
    net.start();
    const children = scene.children.length;
    net.start(); // doble montaje (StrictMode / remonte del mundo)
    expect(net.ballsSystem.count).toBe(9);
    expect(scene.children.length).toBe(children);
    net.dispose();
  });

  it("WorldNet.setNow() llega hasta las pelotas (es el camino que usa la red)", () => {
    const net = new WorldNet({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      playerPosition: new THREE.Vector3(),
      playerForward: (out?: THREE.Vector3) => (out ?? new THREE.Vector3()).set(0, 0, -1),
      playerGrounded: () => true,
      field: flatField as never,
    });
    net.start();
    net.setLocalId("me");
    net.setNow(() => 321_000);
    net.ballsSystem.grab(0);
    expect(net.ballsSystem.stateOf(0).grabT).toBe(321_000);
    net.dispose();
  });

  it("WorldNet acepta el reloj también por deps (construcción directa)", () => {
    const net = new WorldNet({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      playerPosition: new THREE.Vector3(),
      playerForward: (out?: THREE.Vector3) => (out ?? new THREE.Vector3()).set(0, 0, -1),
      playerGrounded: () => true,
      field: flatField as never,
      now: () => 654_000,
    });
    net.start();
    net.setLocalId("me");
    net.ballsSystem.grab(0);
    expect(net.ballsSystem.stateOf(0).grabT).toBe(654_000);
    net.dispose();
  });
});
