import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { AnimationDriver } from "@phygitalia/engine";

/** Clip vacío con nombre (suficiente para el mapeo por nombre del driver). */
function clip(name: string): THREE.AnimationClip {
  return new THREE.AnimationClip(name, 1, []);
}

function driverFor(names: string[]): AnimationDriver {
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  return new AnimationDriver(mixer, names.map(clip));
}

describe("AnimationDriver — mapeo difuso de clips (nombres Tripo/Mixamo)", () => {
  it("mapea nombres 'sucios' (Armature|Walk, Run_01, …) a cada locomoción", () => {
    const d = driverFor(["Armature|Idle", "Armature|Walk", "Run_01", "MyJump"]);
    expect(d.mapping).toEqual({
      idle: "Armature|Idle",
      walk: "Armature|Walk",
      run: "Run_01",
      jump: "MyJump",
    });
    expect(d.clipNames).toHaveLength(4);
  });

  it("degrada con gracia: sin walk usa run; sin jump cae en cascada", () => {
    const d = driverFor(["idle", "Run_01"]);
    expect(d.mapping.walk).toBe("Run_01"); // run a media velocidad
    expect(d.mapping.jump).toBe("Run_01"); // cascada run → walk → idle
  });

  it("sin clip 'idle' usa el primer clip disponible como reposo", () => {
    const d = driverFor(["mixamo.com", "Armature|Walk"]);
    expect(d.mapping.idle).toBe("mixamo.com");
  });

  it("sin ningún clip: mapping en null y update no revienta", () => {
    const d = driverFor([]);
    expect(d.mapping).toEqual({ idle: null, walk: null, run: null, jump: null });
    expect(() =>
      d.update(0.016, { speed: 3, maxSpeed: 7, grounded: true, jumping: false }),
    ).not.toThrow();
  });

  it("update elige idle/walk/run/jump por el estado sin lanzar", () => {
    const d = driverFor(["idle", "walk", "run", "jump"]);
    const states = [
      { speed: 0, maxSpeed: 7, grounded: true, jumping: false },
      { speed: 3, maxSpeed: 7, grounded: true, jumping: false },
      { speed: 7, maxSpeed: 7, grounded: true, jumping: false },
      { speed: 3, maxSpeed: 7, grounded: false, jumping: true },
    ];
    for (const s of states) expect(() => d.update(0.016, s)).not.toThrow();
  });
});
