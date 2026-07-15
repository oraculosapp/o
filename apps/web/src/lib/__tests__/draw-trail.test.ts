import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DrawTrail } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO/MANDOS] Modo DIBUJAR (DrawTrail).
 *  - Cap global de ~2000 puntos con reciclaje (se sueltan los más viejos).
 *  - Persistencia ~30 s y desvanecimiento (cull de puntos caducos).
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

describe("DrawTrail — persistencia ~30 s y fade", () => {
  it("los puntos viven ~30 s y luego se retiran (fade completo)", () => {
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
