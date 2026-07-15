import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CharacterController, IslandField, Vegetation } from "@phygitalia/engine";

/**
 * [EQUIPO TIERRA] Copas de árbol PISABLES.
 *  - Vegetation.platformHeightAt: índice de copas (disco radio·0.8 a cota topY).
 *  - CharacterController: se posa CAYENDO sobre una copa (provider fake) y NO se
 *    teleporta al atravesarla desde abajo.
 */

/** Preset mínimo suficiente para IslandField + Vegetation (forma de paqo.json). */
function makePreset() {
  return {
    palette: {
      primary: "#3C4636",
      secondary: "#93A17C",
      accent: "#ACBD4E",
      ground: "#6B6253",
      sky: "#F79FA8",
    },
    terrain: {
      type: "valley",
      heightNoise: { kind: "perlin", amplitude: 42, frequency: 0.012, octaves: 4 },
      ridges: { enabled: true, steepness: 0.85 },
      centralClearing: { enabled: true, radius: 30, flatness: 0.9 },
      rockScatter: { density: 0.3, mossy: true, lowPolyFacets: 7 },
    },
    vegetation: {
      grass: { density: 0.85, height: 1.4, windSway: 0.6 },
      trees: { type: "gnarled", density: 0.35, mossHang: true, clusterAtEdges: true },
      shrubs: { type: "fern", density: 0.4 },
      flowers: { density: 0.15, colors: ["#9B5DE5", "#F4C542", "#37D6C4"] },
    },
  };
}

describe("Vegetation.platformHeightAt — copas de árbol pisables", () => {
  it("tras build() expone copas por encima del terreno y null donde no hay árbol", () => {
    const field = new IslandField(makePreset() as never, 20260710);
    const veg = new Vegetation(field, makePreset() as never);
    veg.build();

    // Ni en el claro central (sin árboles) ni fuera de la isla hay plataforma.
    expect(veg.platformHeightAt(0, 0)).toBeNull();
    expect(veg.platformHeightAt(300, 300)).toBeNull();

    // Barrido del anillo poblado: cada copa detectada debe quedar SOBRE el terreno.
    let hits = 0;
    for (let x = -52; x <= 52; x += 1) {
      for (let z = -52; z <= 52; z += 1) {
        const r = Math.hypot(x, z);
        if (r < 8 || r > 52) continue;
        const top = veg.platformHeightAt(x, z);
        if (top === null) continue;
        hits++;
        // La copa está por encima del suelo en ese punto (plataforma real, no ras).
        expect(top).toBeGreaterThan(field.heightAt(x, z));
      }
    }
    // Hay muchas copas (~220): el barrido debe encontrar bastantes discos.
    expect(hits).toBeGreaterThan(20);
  }, 20000);
});

describe("CharacterController — aterrizar sobre copa (provider fake)", () => {
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

  /** Isla plana (terreno a Y=0) para aislar la lógica de plataformas. */
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

  it("cayendo sobre la copa (top=3) se posa en su tapa y groundError≈0", () => {
    const controller = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    // Copa a Y=3 en un disco de radio 1 alrededor del origen.
    controller.addHeightProvider((x, z) => (Math.hypot(x, z) < 1 ? 3 : null));

    // Colócalo por encima de la copa y déjalo caer sin input (eyeHeight=0.9 sin
    // rig): pies a 3.5 → cae hasta posarse en la tapa de la copa (Y=3).
    controller.position.set(0, 3.5 + 0.9, 0);
    controller.object.position.copy(controller.position);
    for (let i = 0; i < 60; i++) controller.update(1 / 60, idle);

    expect(controller.isGrounded()).toBe(true);
    expect(controller.feetY).toBeCloseTo(3, 3); // pies sobre la tapa de la copa
    expect(controller.groundError()).toBeCloseTo(0, 3); // error de anclaje coherente
    // De pie sobre la copa el doble salto queda recargado.
    expect(controller.canDoubleJump()).toBe(false);
  });

  it("subiendo NO se teleporta a la copa al atravesarla desde abajo", () => {
    const controller = new CharacterController(flatIsland(), new THREE.Vector3(0, 0, 0));
    controller.addHeightProvider((x, z) => (Math.hypot(x, z) < 1 ? 3 : null));

    // Pies a 2.6 (bajo la copa, top=3) y salto: sube ATRAVESÁNDOLA sin quedar pegado.
    controller.position.set(0, 2.6 + 0.9, 0);
    controller.object.position.copy(controller.position);
    controller.update(1 / 60, { ...idle, jump: true });
    for (let i = 0; i < 8; i++) controller.update(1 / 60, idle);

    expect(controller.isGrounded()).toBe(false); // no lo agarró desde abajo
    expect(controller.feetY).toBeGreaterThan(3); // pasó por encima de la copa
  });
});
