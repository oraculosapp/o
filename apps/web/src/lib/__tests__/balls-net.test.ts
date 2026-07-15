import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Balls } from "@phygitalia/engine";

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

/** Jugador muy abajo y en el origen: no patea ni respawnea nada por proximidad. */
const FAR_PLAYER = new THREE.Vector3(0, -50, 0);
const ZERO = new THREE.Vector3();

afterEach(() => {
  vi.useRealTimers();
});

describe("Balls — difusión del balón AGARRADO (bug del 'agarre invisible')", () => {
  it("mientras llevas el balón, emite su estado por el flujo 'ball' (kickCbs) siguiendo la mano", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const emits: Array<{ id: number; pos: [number, number, number] }> = [];
    balls.onKick((id, s) => emits.push({ id, pos: s.pos }));

    balls.grab(0);
    const hand = new THREE.Vector3(1, 1.15, 0); // r=1, bien dentro de zona
    const player = new THREE.Vector3(0, 1, 0);
    // Primer frame: el acumulador arranca en un periodo → difunde de inmediato.
    balls.update(0.016, player, ZERO, 0.1, hand);

    const mine = emits.filter((e) => e.id === 0);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    // La posición difundida es la de la MANO (no el piso donde estaba).
    const last = mine.at(-1)!;
    expect(last.pos[0]).toBeCloseTo(1, 5);
    expect(last.pos[1]).toBeCloseTo(1.15, 5);
    expect(last.pos[2]).toBeCloseTo(0, 5);
  });

  it("difunde a ~10 Hz (ni cada frame ni una sola vez)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    let count = 0;
    balls.onKick((id) => {
      if (id === 0) count++;
    });
    balls.grab(0);
    const hand = new THREE.Vector3(1, 1.15, 0);
    const player = new THREE.Vector3(0, 1, 0);
    // ~1.0 s a 60 fps: a 10 Hz caben ~10-11 difusiones (no ~60).
    for (let f = 0; f < 63; f++) balls.update(0.016, player, ZERO, 0.1, hand);
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(13);
  });

  it("el RECEPTOR sigue la mano por reconciliación sin descolgarse por gravedad", () => {
    const recv = new Balls(flatField as never);
    recv.build();
    const hand: [number, number, number] = [1, 1.15, 0];
    // Snap inicial a la mano (salto grande desde el slot casa), luego refresco ~10 Hz.
    recv.applyState(0, { pos: hand, vel: [0, 0, 0] });
    for (let f = 0; f < 120; f++) {
      if (f % 6 === 0) recv.applyState(0, { pos: hand, vel: [0, 0, 0] });
      recv.update(0.016, FAR_PLAYER, ZERO);
    }
    const p = recv.stateOf(0).pos;
    expect(Math.hypot(p[0] - 1, p[2] - 0)).toBeLessThan(0.3); // pegado a la mano en XZ
    expect(Math.abs(p[1] - 1.15)).toBeLessThan(0.3); // la gravedad apenas lo descuelga
  });
});

describe("Balls — applyState: snap si el salto es grande dentro de zona", () => {
  it("un salto > SNAP_DIST dentro de zona coloca al instante (agarre/respawn/robo)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.applyState(0, { pos: [10, 5, 0], vel: [0, 0, 0] }); // lejos del home, en zona
    const s = balls.stateOf(0).pos;
    expect(s[0]).toBeCloseTo(10, 5);
    expect(s[1]).toBeCloseTo(5, 5);
  });

  it("un ajuste pequeño NO snapea (queda para el lerp suave)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const home = balls.stateOf(0).pos;
    balls.applyState(0, { pos: [home[0] + 0.5, home[1], home[2]], vel: [0, 0, 0] });
    const s = balls.stateOf(0).pos;
    // Sin snap: la pos instantánea sigue siendo la de casa (reconcilia en el update).
    expect(s[0]).toBeCloseTo(home[0], 5);
    expect(s[2]).toBeCloseTo(home[2], 5);
  });
});

describe("Balls — respawn ALEATORIO dentro del claro (anti-camping)", () => {
  it("respawnToHome cae siempre en el anillo r∈[3.5, 8.5]", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    for (let k = 0; k < 60; k++) {
      balls.respawnToHome(0, "hit");
      const r = xz(balls.stateOf(0).pos);
      expect(r).toBeGreaterThanOrEqual(3.5 - 1e-6);
      expect(r).toBeLessThanOrEqual(8.5 + 1e-6);
      expect(balls.stateOf(0).pos[1]).toBeCloseTo(0.35, 5); // heightAt(0) + RADIUS
    }
  });

  it("es realmente aleatorio (no siempre el mismo punto) y dentro de ZONE_RADIUS", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    const xs = new Set<string>();
    for (let k = 0; k < 30; k++) {
      balls.respawnToHome(0, "out");
      xs.add(balls.stateOf(0).pos[0].toFixed(3));
      expect(xz(balls.stateOf(0).pos)).toBeLessThan(18); // nunca fuera de zona
    }
    expect(xs.size).toBeGreaterThan(1);
  });

  it("una pos aleatoria legítima (en zona) NO la snapea el receptor al slot casa", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    // Un respawn aleatorio entrante en, p.ej., (7,0.35,0) (r=7 < 18) se adopta,
    // NO se fuerza al slot casa determinista (eso sólo pasa si r>18).
    balls.applyState(0, { pos: [7, 0.35, 0], vel: [0, 0, 0] });
    const s = balls.stateOf(0).pos;
    expect(xz(s)).toBeCloseTo(7, 5); // conserva la pos aleatoria (por snap-si-grande)
  });
});

describe("Balls — robo de balón (ball_grab + force-drop)", () => {
  it("grab emite onGrab con (id, t) para difundir 'ball_grab'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const balls = new Balls(flatField as never);
    balls.build();
    const grabs: Array<{ id: number; t: number }> = [];
    balls.onGrab((id, t) => grabs.push({ id, t }));
    expect(balls.grab(3)).toBe(true);
    expect(grabs).toEqual([{ id: 3, t: 5000 }]);
  });

  it("un grab ajeno MÁS NUEVO sobre el balón que llevo → force-drop silencioso (sin throw)", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("victim");
    const thrown: number[] = [];
    balls.onThrow((id) => thrown.push(id));
    balls.grab(0);
    expect(balls.isHolding()).toBe(true);
    expect(balls.heldBall()).toBe(0);

    balls.applyGrab(0, "thief", Date.now() + 1_000_000); // claramente más nuevo
    expect(balls.isHolding()).toBe(false);
    expect(balls.heldBall()).toBe(-1);
    expect(thrown).toHaveLength(0); // se soltó en SILENCIO, no se lanzó
  });

  it("un grab ajeno MÁS VIEJO NO me roba el balón", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("victim");
    balls.grab(0);
    balls.applyGrab(0, "thief", 1); // t=1, muy viejo
    expect(balls.isHolding()).toBe(true);
    expect(balls.heldBall()).toBe(0);
  });

  it("empate de t: gana el id lexicográfico menor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(7000);
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("mmm");
    balls.grab(0); // heldGrabT = 7000

    // by="aaa" < "mmm" en el empate → me roba.
    balls.applyGrab(0, "aaa", 7000);
    expect(balls.isHolding()).toBe(false);

    // Reintento con by="zzz" > "mmm" → conservo.
    vi.setSystemTime(7000);
    balls.grab(0);
    balls.applyGrab(0, "zzz", 7000);
    expect(balls.isHolding()).toBe(true);
  });

  it("ignora el eco de mi propio grab y los grabs de balones que no llevo", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("me");
    balls.grab(0);
    balls.applyGrab(0, "me", Date.now() + 1000); // eco propio
    expect(balls.isHolding()).toBe(true);
    balls.applyGrab(5, "thief", Date.now() + 1000); // otro balón
    expect(balls.isHolding()).toBe(true);
    expect(balls.heldBall()).toBe(0);
  });

  it("un balón held-remoto (movido a la mano de otro) es ROBABLE dentro de GRAB_RANGE", () => {
    const balls = new Balls(flatField as never);
    balls.build();
    balls.setLocalId("thief");
    // El balón 0 lo lleva un remoto y su mano cae junto a mí (snap por salto grande).
    balls.applyState(0, { pos: [0.5, 1.15, 0], vel: [0, 0, 0] });
    expect(balls.canGrab(0, 0)).toBe(true); // el sprite "E" aparecería sobre él
    const id = balls.nearestGrabbable(0, 0);
    expect(id).toBe(0);
    const grabs: number[] = [];
    balls.onGrab((gid) => grabs.push(gid));
    expect(balls.grab(id)).toBe(true);
    expect(grabs).toContain(0); // difunde el 'ball_grab' del robo
  });
});
