import { describe, expect, it } from "vitest";
import { kickStrengthFromVel, MIN_AUDIBLE_KICK_SPEED } from "@phygitalia/engine";

/**
 * Regresión S16 — "la reverberación horrible": el canal `kickCbs` de Balls está
 * MULTIPLEXADO con datos de red (broadcast a ~10 Hz del balón AGARRADO y snap de
 * respawn, ambos con velocidad ≈ 0). Sin distinguir dato↔sonido, el portador de
 * una pelota oía una ametralladora de pops (y una campana continua con la dorada)
 * que el delay del foley embarraba en una reverberación continua. La regla:
 * velocidad ≈ 0 ⇒ es DATO (fuerza 0, no suena); una patada real garantiza
 * ≥ KICK_MIN (2 u/s) y un lanzamiento sale a THROW_SPEED (9.5).
 */
describe("kickStrengthFromVel — separa dato de red ↔ patada audible", () => {
  it("balón agarrado / respawn (vel = 0) es dato: fuerza 0, NO suena", () => {
    expect(kickStrengthFromVel([0, 0, 0])).toBe(0);
  });

  it("ruido numérico bajo el umbral sigue siendo silencio", () => {
    const casi = MIN_AUDIBLE_KICK_SPEED * 0.99;
    expect(kickStrengthFromVel([casi, 0, 0])).toBe(0);
    expect(kickStrengthFromVel([0, 5, 0])).toBe(0); // vel vertical pura: no es patada
  });

  it("la patada mínima real (KICK_MIN = 2 u/s) SIEMPRE suena", () => {
    const s = kickStrengthFromVel([2, 0, 0]);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeCloseTo(2 / 8, 5);
  });

  it("un lanzamiento (THROW_SPEED = 9.5 u/s) satura a fuerza 1", () => {
    expect(kickStrengthFromVel([9.5, 0, 0])).toBe(1);
  });

  it("usa solo la velocidad horizontal (x, z), con clamp 0..1", () => {
    expect(kickStrengthFromVel([3, 99, 4])).toBeCloseTo(5 / 8, 5); // hipot(3,4)=5
    expect(kickStrengthFromVel([80, 0, 60])).toBe(1);
  });
});
