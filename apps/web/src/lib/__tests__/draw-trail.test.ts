import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DrawTrail } from "@phygitalia/engine";

/**
 * [EQUIPO VUELO/MANDOS] Modo DIBUJAR (DrawTrail).
 *  - Cap global de ~2000 puntos con reciclaje (se sueltan los más viejos).
 *  - Persistencia de 6 s y BORRADO GEOMÉTRICO: el trazo nunca se transparenta ni
 *    se ensancha; la cola se lo va comiendo por el mismo camino y al mismo ritmo
 *    con que se pintó (una goma 6 s por detrás del pincel).
 *  - Difusión: lotes de ≤40 puntos [x,y,z] cada ~0.5 s (onBatch); los lotes
 *    remotos se pintan con el mismo sistema (applyRemoteBatch).
 */

const CAM = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
/** Vida de cada punto (s) — debe coincidir con LIFE del engine. */
const LIFE = 6;
/** Paso mínimo entre puntos (u) — debe coincidir con MIN_STEP del engine. */
const MIN_STEP = 0.14;
/** Semiancho del ribbon (u) — debe coincidir con HALF_WIDTH del engine. */
const HALF_WIDTH = 0.06;

/** Monta un trazo dentro de una escena para poder leerle la geometría (QA). */
function mounted() {
  const trail = new DrawTrail();
  const scene = new THREE.Scene();
  trail.addTo(scene);
  const mesh = scene.children[0] as THREE.Mesh;
  const geo = mesh.geometry as THREE.BufferGeometry;
  return {
    trail,
    /** Nº de índices dibujados (6 por segmento del ribbon). */
    drawn: () => geo.drawRange.count,
    col: () => geo.getAttribute("color") as THREE.BufferAttribute,
    /** Centro del extremo de la COLA (par de vértices 0/1 del primer trazo). */
    tailX: () => {
      const p = geo.getAttribute("position") as THREE.BufferAttribute;
      return (p.getX(0) + p.getX(1)) / 2;
    },
    /** Ancho del ribbon en el punto `i` (vértices i·2 y i·2+1). */
    widthAt: (i: number) => {
      const p = geo.getAttribute("position") as THREE.BufferAttribute;
      const dx = p.getX(i * 2) - p.getX(i * 2 + 1);
      const dy = p.getY(i * 2) - p.getY(i * 2 + 1);
      const dz = p.getZ(i * 2) - p.getZ(i * 2 + 1);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
  };
}

/**
 * Canal máximo del color de un vértice. Con S y L fijos, HSL→RGB da SIEMPRE el
 * mismo canal máximo sea cual sea el matiz → es un invariante independiente del
 * arcoíris, que se rompería en cuanto hubiera cualquier atenuación.
 */
function maxChannel(col: THREE.BufferAttribute, v: number): number {
  return Math.max(col.getX(v), col.getY(v), col.getZ(v));
}

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

describe("DrawTrail — vida de 6 s y retirada exacta", () => {
  it("los puntos aguantan hasta los 6 s y entonces se retiran", () => {
    const trail = new DrawTrail();
    const points: number[] = [];
    for (let i = 0; i < 10; i++) points.push(i * 0.5, 0.5, 0);
    trail.applyRemoteBatch("remoto-1", { stroke: 0, points });
    expect(trail.pointCount()).toBe(10);

    const pos = new THREE.Vector3();
    // A 5.9 s el trazo sigue ENTERO (no ha perdido ni un punto por el camino).
    trail.update(5.9, pos, 0, CAM);
    expect(trail.pointCount()).toBe(10);
    // Al cumplirse la vida se retiran (nacieron todos en el mismo instante).
    trail.update(0.2, pos, 0, CAM);
    expect(trail.pointCount()).toBe(0);
    trail.dispose();
  });

  it("a los 6 s exactos ya no queda nada del punto", () => {
    const trail = new DrawTrail();
    trail.applyRemoteBatch("remoto-1", { stroke: 0, points: [0, 0.5, 0, 1, 0.5, 0] });
    const pos = new THREE.Vector3();
    trail.update(LIFE, pos, 0, CAM);
    expect(trail.pointCount()).toBe(0);
    expect(trail.strokeCount()).toBe(0);
    trail.dispose();
  });
});

describe("DrawTrail — el trazo NO se desvanece ni se ensancha mientras vive", () => {
  it("mantiene el mismo ancho y la misma intensidad del primer al último frame", () => {
    const m = mounted();
    const pos = new THREE.Vector3(0, 1.5, 0);

    // Pinta ~2 s caminando a 4 u/s (velocidad de paseo del avatar).
    m.trail.setDrawing(true);
    for (let i = 0; i < 120; i++) {
      pos.x += 4 / 60;
      m.trail.update(1 / 60, pos, 1.0, CAM);
    }
    m.trail.setDrawing(false);
    // A 4 u/s y 1/60 s por frame se avanza 0.067 u: se añade punto cada 3 frames
    // (0.2 u ≥ MIN_STEP). 120 frames → 40 puntos.
    expect(m.trail.pointCount()).toBe(40);

    const ref = maxChannel(m.col(), 0);
    expect(ref).toBeGreaterThan(0.1); // hay tinta de verdad

    // Recorre el resto de la vida del trazo: ni un solo vértice se atenúa ni el
    // ribbon se abre. Si hubiera fade o ensanche, esto cae en el primer frame.
    let comprobados = 0;
    for (let i = 0; i < 400 && m.trail.pointCount() > 1; i++) {
      m.trail.update(1 / 60, pos, 1.0, CAM);
      const verts = m.drawn() / 3 + 1; // índices → vértices realmente dibujados
      for (let v = 0; v < verts; v++) {
        expect(maxChannel(m.col(), v)).toBeCloseTo(ref, 5);
        comprobados++;
      }
      for (let k = 0; k * 2 + 1 < verts; k++) {
        expect(m.widthAt(k)).toBeCloseTo(2 * HALF_WIDTH, 5);
      }
    }
    expect(comprobados).toBeGreaterThan(1000);
    m.trail.dispose();
  });
});

describe("DrawTrail — la goma recorre el trazo en el orden en que se pintó", () => {
  it("la cola avanza hacia delante, nunca hacia atrás, y acaba vaciando el trazo", () => {
    const m = mounted();
    const pos = new THREE.Vector3(0, 1.5, 0);

    m.trail.setDrawing(true);
    for (let i = 0; i < 180; i++) {
      pos.x += 4 / 60; // camina en +X: el trazo se pinta de x≈0 hacia x≈12
      m.trail.update(1 / 60, pos, 1.0, CAM);
    }
    m.trail.setDrawing(false);
    expect(m.trail.pointCount()).toBe(60); // 180 frames / 3 → punto cada 0.2 u

    // La cola arranca en el ORIGEN del trazo, no en el final.
    expect(m.tailX()).toBeLessThan(0.5);

    let prevTail = m.tailX();
    let prevCount = m.trail.pointCount();
    let frames = 0;
    while (m.trail.pointCount() > 0 && frames < 1200) {
      m.trail.update(1 / 60, pos, 1.0, CAM);
      frames++;
      if (m.trail.pointCount() === 0) break;
      const tail = m.tailX();
      // Monótona hacia delante: la goma sigue el camino del pincel, no vuelve.
      expect(tail).toBeGreaterThanOrEqual(prevTail - 1e-6);
      // Y solo se pierden puntos, nunca se ganan (ya no se dibuja).
      expect(m.trail.pointCount()).toBeLessThanOrEqual(prevCount);
      prevTail = tail;
      prevCount = m.trail.pointCount();
    }
    // Se vació dentro de lo esperado (3 s de trazo + 6 s de vida ≈ 540 frames).
    expect(m.trail.pointCount()).toBe(0);
    expect(frames).toBeLessThan(700);
    // Y la goma llegó hasta el final del trazo (x≈12) antes de desaparecer.
    expect(prevTail).toBeGreaterThan(10);
    m.trail.dispose();
  });

  it("el extremo DESLIZA por el path en vez de saltar de punto en punto", () => {
    const m = mounted();
    const pos = new THREE.Vector3(0, 1.5, 0);

    m.trail.setDrawing(true);
    for (let i = 0; i < 180; i++) {
      pos.x += 4 / 60;
      m.trail.update(1 / 60, pos, 1.0, CAM);
    }
    m.trail.setDrawing(false);

    // El trazo tiene 3 s: hay que esperar a que el más viejo cumpla los 6 para
    // que la goma arranque. Avanza hasta que empiece a comer.
    let arranque = 0;
    const antes = m.trail.pointCount();
    while (m.trail.pointCount() === antes && arranque < 600) {
      m.trail.update(1 / 60, pos, 1.0, CAM);
      arranque++;
    }
    // ≈ 6 s de vida − 3 s ya vividos = ~180 frames (+3 hasta soltar el ancla).
    expect(arranque).toBeGreaterThan(150);
    expect(arranque).toBeLessThan(250);

    let prev = m.tailX();
    let maxStep = 0;
    let movidos = 0;
    let total = 0;
    for (let i = 0; i < 120 && m.trail.pointCount() > 1; i++) {
      m.trail.update(1 / 60, pos, 1.0, CAM);
      const tail = m.tailX();
      const step = tail - prev;
      if (step > maxStep) maxStep = step;
      if (step > 1e-6) movidos++;
      total++;
      prev = tail;
    }
    // Sin interpolación el extremo saltaría los MIN_STEP=0.14 u de golpe cada
    // ~2 frames; con ella avanza ~4/60 = 0.067 u por frame, TODOS los frames.
    expect(total).toBeGreaterThan(100);
    expect(maxStep).toBeGreaterThan(0);
    expect(maxStep).toBeLessThan(MIN_STEP * 0.75);
    expect(movidos).toBe(total); // se mueve cada frame, no a golpes
    m.trail.dispose();
  });

  it("con el avatar parado la cola espera y luego salta el hueco (documentado)", () => {
    const m = mounted();
    const pos = new THREE.Vector3(0, 1.5, 0);

    // Dos puntos y una PAUSA larga entre ellos: el avatar se queda quieto 2 s.
    m.trail.setDrawing(true);
    m.trail.update(1 / 60, pos, 1.0, CAM); // punto A en x≈0
    for (let i = 0; i < 120; i++) m.trail.update(1 / 60, pos, 1.0, CAM); // quieto
    pos.x += 1; // se mueve de golpe → punto B en x≈1
    m.trail.update(1 / 60, pos, 1.0, CAM);
    m.trail.setDrawing(false);
    expect(m.trail.pointCount()).toBe(2);

    // A muere a los 6 s; B ~2 s después. Entre medias la cola recorre A→B a la
    // misma velocidad "lenta" con la que se pintó ese tramo: sigue sin saltar.
    let prev = m.tailX();
    let maxStep = 0;
    for (let i = 0; i < 480 && m.trail.pointCount() > 1; i++) {
      m.trail.update(1 / 60, pos, 1.0, CAM);
      const step = m.tailX() - prev;
      if (step > maxStep) maxStep = step;
      prev = m.tailX();
    }
    expect(prev).toBeGreaterThan(0.9); // llegó hasta B
    expect(maxStep).toBeLessThan(0.02); // el hueco de 1 u lo cruzó despacio
    m.trail.dispose();
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
