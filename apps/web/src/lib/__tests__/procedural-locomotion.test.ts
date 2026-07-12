import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ProceduralLocomotion } from "@phygitalia/engine";

/**
 * Construye un esqueleto humanoide mínimo con nombres Mixamo "sucios"
 * (prefijo `mixamorig:` + sufijo `_NN`) para ejercitar el mapeo robusto y el
 * ciclo procedural sin depender del GLB real.
 */
function mixamoRig(): THREE.Object3D {
  const root = new THREE.Object3D();
  const bone = (name: string, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...pos);
    return b;
  };
  const hips = bone("mixamorig:Hips_01", [0, 1, 0]);
  const spine = bone("mixamorig:Spine_02", [0, 0.2, 0]);
  const spine1 = bone("mixamorig:Spine1_03", [0, 0.2, 0]);
  const neck = bone("mixamorig:Neck_05", [0, 0.2, 0]);
  const head = bone("mixamorig:Head_06", [0, 0.15, 0]);
  const lArm = bone("mixamorig:LeftArm_08", [0.2, 0.1, 0]);
  const lFore = bone("mixamorig:LeftForeArm_09", [0.25, 0, 0]);
  const rArm = bone("mixamorig:RightArm_019", [-0.2, 0.1, 0]);
  const rFore = bone("mixamorig:RightForeArm_020", [-0.25, 0, 0]);
  const lUp = bone("mixamorig:LeftUpLeg_030", [0.1, -0.05, 0]);
  const lLeg = bone("mixamorig:LeftLeg_031", [0, -0.45, 0]);
  const lFoot = bone("mixamorig:LeftFoot_032", [0, -0.45, 0]);
  const rUp = bone("mixamorig:RightUpLeg_035", [-0.1, -0.05, 0]);
  const rLeg = bone("mixamorig:RightLeg_036", [0, -0.45, 0]);
  const rFoot = bone("mixamorig:RightFoot_037", [0, -0.45, 0]);

  spine1.add(neck);
  neck.add(head);
  spine.add(spine1);
  lArm.add(lFore);
  rArm.add(rFore);
  lUp.add(lLeg);
  lLeg.add(lFoot);
  rUp.add(rLeg);
  rLeg.add(rFoot);
  hips.add(spine, lArm, rArm, lUp, rUp);
  root.add(hips);
  root.updateMatrixWorld(true);
  return root;
}

const walkState = { speed: 3, maxSpeed: 7, grounded: true, jumping: false };

describe("ProceduralLocomotion — locomoción procedural sobre huesos Mixamo", () => {
  it("mapea huesos con prefijo mixamorig: y sufijos _NN (sin depender del GLB)", () => {
    const loco = ProceduralLocomotion.tryCreate(mixamoRig());
    expect(loco).not.toBeNull();
    const qa = loco!.getQA();
    expect(qa.active).toBe(true);
    expect(qa.mappedBones).toEqual(
      expect.arrayContaining(["hips", "leftUpLeg", "rightUpLeg", "leftLeg", "rightLeg", "leftArm"]),
    );
  });

  it("NO aplica si faltan huesos clave (cadera + 2 piernas) → tryCreate null", () => {
    const root = new THREE.Object3D();
    const hips = new THREE.Bone();
    hips.name = "mixamorig:Hips_01";
    root.add(hips);
    root.updateMatrixWorld(true);
    expect(ProceduralLocomotion.tryCreate(root)).toBeNull();
  });

  it("la fase avanza con la DISTANCIA recorrida (cero patinaje), no con el tiempo", () => {
    const loco = ProceduralLocomotion.tryCreate(mixamoRig())!;
    // Mismo dt, distinta velocidad → distinto avance de fase, proporcional.
    loco.update(0.1, { speed: 2, maxSpeed: 7, grounded: true, jumping: false });
    const p1 = loco.getQA().phase;
    loco.update(0.1, { speed: 4, maxSpeed: 7, grounded: true, jumping: false });
    const p2 = loco.getQA().phase;
    const d1 = p1; // avance con speed 2
    const d2 = p2 - p1; // avance con speed 4
    // El segundo avance duplica al primero (fase ∝ velocidad·dt = distancia).
    expect(d2).toBeGreaterThan(d1 * 1.6);
    // Parado en el suelo → la fase se congela.
    const pf = loco.getQA().phase;
    loco.update(0.1, { speed: 0, maxSpeed: 7, grounded: true, jumping: false });
    expect(loco.getQA().phase).toBeCloseTo(pf, 5);
  });

  it("piernas en ANTIFASE: los muslos izq/der giran en sentidos opuestos", () => {
    const root = mixamoRig();
    const loco = ProceduralLocomotion.tryCreate(root)!;
    // Avanza hasta un cuarto de ciclo para separar bien las fases.
    for (let i = 0; i < 8; i++) loco.update(0.05, walkState);
    const find = (s: string) => {
      let b: THREE.Object3D | undefined;
      root.traverse((o) => {
        if (!b && o.name.includes(s)) b = o;
      });
      return b!;
    };
    const lUp = find("LeftUpLeg");
    const rUp = find("RightUpLeg");
    // Los ángulos de rotación (respecto a reposo) deben tener signo opuesto.
    const angL = 2 * Math.acos(Math.min(1, Math.abs(lUp.quaternion.w)));
    const angR = 2 * Math.acos(Math.min(1, Math.abs(rUp.quaternion.w)));
    expect(angL).toBeGreaterThan(0.001);
    expect(angR).toBeGreaterThan(0.001);
    // Antifase: sin(phase) y sin(phase+π) tienen signos opuestos.
    const qa = loco.getQA();
    expect(Math.sign(qa.legPhaseL)).toBe(-Math.sign(qa.legPhaseR));
  });

  it("idle mueve la columna (respiración) sin lanzar", () => {
    const root = mixamoRig();
    const loco = ProceduralLocomotion.tryCreate(root)!;
    const spine = (() => {
      let b: THREE.Object3D | undefined;
      root.traverse((o) => {
        if (!b && o.name.includes("Spine_")) b = o;
      });
      return b!;
    })();
    const rest = spine.quaternion.clone();
    // Varios frames en idle → la columna oscila respecto a reposo en algún momento.
    let moved = false;
    for (let i = 0; i < 30; i++) {
      loco.update(0.05, { speed: 0, maxSpeed: 7, grounded: true, jumping: false });
      if (spine.quaternion.angleTo(rest) > 1e-4) moved = true;
    }
    expect(moved).toBe(true);
  });

  it("salto/aire posiciona (blend rápido) sin lanzar y con QA gait='air'", () => {
    const loco = ProceduralLocomotion.tryCreate(mixamoRig())!;
    for (let i = 0; i < 6; i++) {
      loco.update(0.05, { speed: 2, maxSpeed: 7, grounded: false, jumping: true });
    }
    expect(loco.getQA().gait).toBe("air");
  });
});
