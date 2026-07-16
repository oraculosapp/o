import { describe, expect, it } from "vitest";
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
