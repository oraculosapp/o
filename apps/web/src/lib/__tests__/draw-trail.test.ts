import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DrawTrail } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO/MANDOS] Modo DIBUJAR (DrawTrail).
 *  - Cap global de ~2000 puntos con reciclaje (se sueltan los más viejos).
 *  - Persistencia ~30 s y DESDIBUJADO (el trazo se abre y se lava hasta perderse;
 *    cull de puntos caducos al cumplir la vida).
 *  - Difusión: lotes de ≤40 puntos [x,y,z] cada ~0.5 s (onBatch); los lotes
 *    remotos se pintan con el mismo sistema (applyRemoteBatch).
 */

const CAM = new THREE.PerspectiveCamera(50, 1, 0.1, 200);

describe("DrawTrail — cap de puntos con reciclaje", () => {
  it("nunca supera ~2000 puntos vivos aunque lleguen muchos más", () => {
    const trail = new DrawTrail();
    // 70 lotes remotos de 40 puntos = 2800 puntos (espaciados > paso mínimo).
    for (let b = 0; b < 70; b++) {
      const points: number[] = [];
      for (let i = 0; i < 40; i++) {
        const n = b * 40 + i;
        points.push(n * 0.2, 0.5, 0);
      }
      trail.applyRemoteBatch("remoto-1", { stroke: b, points });
    }
    expect(trail.pointCount()).toBeLessThanOrEqual(2000);
    expect(trail.pointCount()).toBeGreaterThan(1500); // recicló, no borró todo
    trail.dispose();
  });

  it("puntos demasiado juntos (< paso mínimo) no se acumulan", () => {
    const trail = new DrawTrail();
    const points: number[] = [];
    for (let i = 0; i < 40; i++) points.push(0.001 * i, 0.5, 0); // casi el mismo punto
    trail.applyRemoteBatch("remoto-1", { stroke: 0, points });
    expect(trail.pointCount()).toBe(1);
    trail.dispose();
  });
});

describe("DrawTrail — persistencia ~30 s y desdibujado", () => {
  it("los puntos viven ~30 s y luego se retiran (desdibujado completo)", () => {
    const trail = new DrawTrail();
    const points: number[] = [];
    for (let i = 0; i < 10; i++) points.push(i * 0.5, 0.5, 0);
    trail.applyRemoteBatch("remoto-1", { stroke: 0, points });
    expect(trail.pointCount()).toBe(10);

    const pos = new THREE.Vector3();
    // A los ~29 s siguen vivos (desvaneciéndose)…
    trail.update(29, pos, 0, CAM);
    expect(trail.pointCount()).toBe(10);
    // …pasados los 30 s se retiran del todo.
    trail.update(2, pos, 0, CAM);
    expect(trail.pointCount()).toBe(0);
    trail.dispose();
  });
});

describe("DrawTrail — curvas del desdibujado (ancho / brillo / lavado)", () => {
  /** Muestreo denso de la vida normalizada del punto: 0 (fresco) → 1 (perdido). */
  const SAMPLES = 201;
  const ts = Array.from({ length: SAMPLES }, (_, i) => i / (SAMPLES - 1));

  it("el semiancho se ABRE con la edad, de 1× a ~5×, y sin salto al nacer", () => {
    expect(DrawTrail.smudgeWidth(0)).toBeCloseTo(1, 6);
    expect(DrawTrail.smudgeWidth(1)).toBeCloseTo(5, 6);
    // Monótono creciente: nunca se estrecha.
    for (let i = 1; i < ts.length; i++) {
      expect(DrawTrail.smudgeWidth(ts[i])).toBeGreaterThanOrEqual(DrawTrail.smudgeWidth(ts[i - 1]));
    }
    // Arranque suave (derivada ~0 en t=0): el punto recién trazado se lee nítido.
    expect(DrawTrail.smudgeWidth(0.02)).toBeLessThan(1.02);
    // A media vida ya se nota que se ha abierto, pero sin llegar al extremo.
    const half = DrawTrail.smudgeWidth(0.5);
    expect(half).toBeGreaterThan(2);
    expect(half).toBeLessThan(3);
    // Fuera de rango se clampea (no explota ni se vuelve negativo).
    expect(DrawTrail.smudgeWidth(-1)).toBeCloseTo(1, 6);
    expect(DrawTrail.smudgeWidth(4)).toBeCloseTo(5, 6);
  });

  it("la intensidad decae de forma monótona y llega a 0 justo al cumplir la vida", () => {
    expect(DrawTrail.smudgeGain(0)).toBeCloseTo(1, 6);
    expect(DrawTrail.smudgeGain(1)).toBe(0);
    expect(DrawTrail.smudgeGain(2)).toBe(0); // ya retirado
    for (let i = 1; i < ts.length; i++) {
      expect(DrawTrail.smudgeGain(ts[i])).toBeLessThanOrEqual(DrawTrail.smudgeGain(ts[i - 1]));
    }
    // Llega a cero con pendiente ~0 → retirar el punto en LIFE no da corte visible.
    expect(DrawTrail.smudgeGain(0.99)).toBeLessThan(0.001);
  });

  it("conserva la tinta mientras se difumina y solo la pierde al final", () => {
    // Brillo integrado a lo ancho ≈ gain × ancho. Se mantiene ~1 en la primera
    // mitad de la vida (se DESDIBUJA, no se desvanece)…
    for (const t of [0, 0.1, 0.25, 0.4]) {
      expect(DrawTrail.smudgeGain(t) * DrawTrail.smudgeWidth(t)).toBeCloseTo(1, 6);
    }
    // …y a partir de ahí se va perdiendo hasta apagarse del todo.
    expect(DrawTrail.smudgeGain(0.7) * DrawTrail.smudgeWidth(0.7)).toBeLessThan(0.7);
    expect(DrawTrail.smudgeGain(0.9) * DrawTrail.smudgeWidth(0.9)).toBeLessThan(0.2);
    expect(DrawTrail.smudgeGain(1) * DrawTrail.smudgeWidth(1)).toBe(0);
    // El pico sí baja siempre: es lo que hace que el trazo se ablande.
    expect(DrawTrail.smudgeGain(0.5)).toBeLessThan(0.5);
  });

  it("el lavado del color va acompasado al ensanche (misma curva maestra)", () => {
    expect(DrawTrail.smudgeWash(0)).toBe(0);
    expect(DrawTrail.smudgeWash(1)).toBe(1);
    for (const t of ts) {
      // width = 1 + 4·wash por construcción: un solo perfil gobierna ambos.
      expect(DrawTrail.smudgeWidth(t)).toBeCloseTo(1 + 4 * DrawTrail.smudgeWash(t), 6);
    }
    for (let i = 1; i < ts.length; i++) {
      expect(DrawTrail.smudgeWash(ts[i])).toBeGreaterThanOrEqual(DrawTrail.smudgeWash(ts[i - 1]));
    }
  });

  it("update() sigue reconstruyendo sin romper con puntos de cualquier edad", () => {
    const trail = new DrawTrail();
    const points: number[] = [];
    for (let i = 0; i < 12; i++) points.push(i * 0.5, 0.5, 0);
    trail.applyRemoteBatch("remoto-1", { stroke: 0, points });
    const pos = new THREE.Vector3();
    // Recorre toda la vida en pasos: no debe lanzar en ningún punto de la curva.
    for (let i = 0; i < 32; i++) trail.update(1, pos, 0, CAM);
    expect(trail.pointCount()).toBe(0);
    trail.dispose();
  });
});

describe("DrawTrail — trazo local: setDrawing/isDrawing + lotes de difusión", () => {
  it("dibuja desde la posición del jugador y difunde lotes de ≤40 puntos", () => {
    const trail = new DrawTrail();
    const batches: Array<{ stroke: number; points: number[] }> = [];
    trail.onBatch((b) => batches.push({ stroke: b.stroke, points: [...b.points] }));

    expect(trail.isDrawing()).toBe(false);
    trail.setDrawing(true);
    expect(trail.isDrawing()).toBe(true);

    // El jugador camina 0.2 u por frame durante ~1.2 s (paso > mínimo, añade punto).
    const pos = new THREE.Vector3(0, 1.5, 0);
    for (let i = 0; i < 24; i++) {
      pos.x += 0.2;
      trail.update(0.05, pos, 1.0, CAM); // pies a 1.0 → traza a 1.5
    }
    trail.setDrawing(false); // cierra el trazo y vacía lo pendiente
    expect(trail.isDrawing()).toBe(false);

    // Se pintaron puntos y TODOS se difundieron en lotes de ≤40 puntos.
    const drawn = trail.pointCount();
    expect(drawn).toBeGreaterThan(10);
    const sent = batches.reduce((acc, b) => acc + b.points.length / 3, 0);
    expect(sent).toBe(drawn);
    for (const b of batches) {
      expect(b.points.length % 3).toBe(0);
      expect(b.points.length / 3).toBeLessThanOrEqual(40);
      expect(b.points.every((n) => Number.isFinite(n))).toBe(true);
      expect(b.stroke).toBe(0); // primer trazo local
    }
    // La altura del trazo es pies+0.5.
    expect(batches[0].points[1]).toBeCloseTo(1.5, 5);

    // Un segundo trazo usa un id nuevo (las líneas no se unen entre sí).
    trail.setDrawing(true);
    pos.x += 5;
    trail.update(0.05, pos, 1.0, CAM);
    trail.setDrawing(false);
    const last = batches[batches.length - 1];
    expect(last.stroke).toBe(1);
    trail.dispose();
  });

  it("los lotes remotos se pintan con el mismo sistema (strokes independientes)", () => {
    const trail = new DrawTrail();
    trail.applyRemoteBatch("a", { stroke: 0, points: [0, 1, 0, 1, 1, 0, 2, 1, 0] });
    trail.applyRemoteBatch("b", { stroke: 0, points: [0, 2, 5, 1, 2, 5] });
    expect(trail.pointCount()).toBe(5);
    expect(trail.strokeCount()).toBe(2); // mismo stroke id, dueños distintos
    trail.dispose();
  });
});
