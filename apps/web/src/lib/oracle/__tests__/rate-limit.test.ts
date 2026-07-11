import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../rate-limit";

describe("createRateLimiter", () => {
  it("permite hasta el límite y luego bloquea con retryAfter", () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });

    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("recupera cupo al pasar la ventana", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false);
    t = 1_100; // ventana expirada
    expect(rl.check("k").allowed).toBe(true);
  });

  it("aísla claves distintas", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
  });
});
