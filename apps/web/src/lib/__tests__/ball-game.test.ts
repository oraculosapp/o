import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { BallGame, type GameEvent } from "@phygitalia/engine";

/**
 * Mock ligero de Balls: sólo la superficie que consume BallGame (count, isLiveByLocal,
 * positionOf, respawnToHome, deflect, onRespawn). Evita canvas/WebGL de la Balls
 * real y deja controlar posiciones/atribuciones de forma determinista.
 */
class MockBalls {
  count = 9;
  private thrown = new Set<number>();
  private positions = new Map<number, THREE.Vector3>();
  respawned: Array<{ id: number; reason: string }> = [];
  deflected: number[] = [];

  onRespawn(): () => void {
    return () => {};
  }
  isLiveByLocal(id: number): boolean {
    return this.thrown.has(id);
  }
  positionOf(id: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.positions.get(id) ?? new THREE.Vector3());
  }
  respawnToHome(id: number, reason: "out" | "hit"): void {
    this.respawned.push({ id, reason });
    this.thrown.delete(id);
  }
  deflect(id: number): void {
    this.deflected.push(id);
  }
  // helpers de test
  throwAt(id: number, x: number, y: number, z: number): void {
    this.thrown.add(id);
    this.positions.set(id, new THREE.Vector3(x, y, z));
  }
}

/** Tótem de prueba: caja 4×8×4 centrada en el origen (Box3 y=[-4,4], radio≈1.95). */
function makeTotem(): THREE.Group {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(4, 8, 4),
    new THREE.MeshBasicMaterial(),
  );
  g.add(mesh);
  g.updateMatrixWorld(true);
  return g;
}

interface Harness {
  game: BallGame;
  balls: MockBalls;
  totem: THREE.Group | null;
  sounds: string[];
  events: GameEvent[];
}

function makeGame(withTotem = true): Harness {
  const balls = new MockBalls();
  const sounds: string[] = [];
  const state = { totem: withTotem ? makeTotem() : null };
  const game = new BallGame({
    scene: new THREE.Scene(),
    balls: balls as unknown as never,
    field: {} as never,
    getTotem: () => state.totem,
    onSound: (k) => sounds.push(k),
  });
  const events: GameEvent[] = [];
  game.onLocalEvent((e) => events.push(e));
  return { game, balls, totem: state.totem, sounds, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BallGame — máquina del mini-juego ¡Dale a Paqo!", () => {
  it("arranca en idle con snapshot neutro", () => {
    const { game } = makeGame();
    const s = game.snapshot();
    expect(s.phase).toBe("idle");
    expect(s.endsAt).toBe(0);
    expect(s.scores).toEqual({});
  });

  it("start() pasa a running (endsAt futuro), emite 'start' y suena", () => {
    const { game, events, sounds } = makeGame();
    game.setLocalPlayer("me");
    const before = Date.now();
    game.start();
    const s = game.snapshot();
    expect(s.phase).toBe("running");
    expect(s.endsAt).toBeGreaterThan(before);
    expect(s.startedBy).toBe("me");
    expect(events.at(-1)).toMatchObject({ type: "start", by: "me" });
    expect(sounds).toContain("start");
  });

  it("golpe de pelota atribuida al local dentro del cilindro puntúa y respawnea", () => {
    const { game, balls, events, sounds } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    balls.throwAt(0, 0, 0, 0); // centro del tótem, dentro del cilindro
    game.update(0.016);
    expect(game.snapshot().scores.me).toBe(1);
    expect(balls.respawned).toContainEqual({ id: 0, reason: "hit" });
    expect(sounds).toContain("hit");
    expect(events.at(-1)).toMatchObject({ type: "hit", by: "me", ballId: 0 });
  });

  it("pelota fuera del radio del cilindro NO puntúa", () => {
    const { game, balls } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    balls.throwAt(0, 5, 0, 0); // r=5 ≫ radio ≈1.95
    game.update(0.016);
    expect(game.snapshot().scores).toEqual({});
    expect(balls.respawned).toHaveLength(0);
  });

  it("sin partida (idle) el golpe NO puntúa pero Paqo reacciona (deflect)", () => {
    const { game, balls } = makeGame();
    balls.throwAt(0, 0, 0, 0);
    game.update(0.016);
    expect(game.snapshot().scores).toEqual({});
    expect(balls.deflected).toContain(0);
    expect(balls.respawned).toHaveLength(0);
  });

  it("fin de ronda (now ≥ endsAt) → results con ganadores empatados al máximo", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { game } = makeGame();
    game.setLocalPlayer("me");
    game.start(); // endsAt = 180000
    // Puntúa "me" y "otro" (aplica hits remotos para no depender de colisión).
    game.applyRemote({ type: "hit", by: "me", ballId: 1, hitPos: [0, 0, 0] });
    game.applyRemote({ type: "hit", by: "me", ballId: 2, hitPos: [0, 0, 0] });
    game.applyRemote({ type: "hit", by: "otro", ballId: 3, hitPos: [0, 0, 0] });
    vi.setSystemTime(180_001);
    game.update(0.016);
    const s = game.snapshot();
    expect(s.phase).toBe("results");
    expect(s.winnerIds).toEqual(["me"]); // 2 > 1
  });

  it("results vuelve a idle solo tras la ventana de 8s (scores limpios)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { game } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    game.applyRemote({ type: "hit", by: "me", ballId: 1, hitPos: [0, 0, 0] });
    vi.setSystemTime(180_001);
    game.update(0.016); // → results
    expect(game.snapshot().phase).toBe("results");
    vi.setSystemTime(180_001 + 8_001);
    game.update(0.016); // → idle
    const s = game.snapshot();
    expect(s.phase).toBe("idle");
    expect(s.scores).toEqual({});
  });

  it("merge idempotente de 'state': puntos = max(local, recibido)", () => {
    const { game } = makeGame();
    const future = Date.now() + 120_000;
    game.applyRemote({ type: "state", endsAt: future, scores: { a: 2, b: 1 }, startedBy: "a" });
    expect(game.snapshot().phase).toBe("running"); // late-join adopta la ronda
    expect(game.snapshot().scores).toEqual({ a: 2, b: 1 });
    // Reaplicar el MISMO estado no cambia nada (idempotente).
    game.applyRemote({ type: "state", endsAt: future, scores: { a: 2, b: 1 }, startedBy: "a" });
    expect(game.snapshot().scores).toEqual({ a: 2, b: 1 });
    // Un estado con menos puntos no baja el marcador (max).
    game.applyRemote({ type: "state", endsAt: future, scores: { a: 1 }, startedBy: "a" });
    expect(game.snapshot().scores.a).toBe(2);
    // Uno con más, sí sube.
    game.applyRemote({ type: "state", endsAt: future, scores: { a: 5 }, startedBy: "a" });
    expect(game.snapshot().scores.a).toBe(5);
  });

  it("applyRemote 'hit' puntúa y hace poof (sonido) pero NO respawnea local (autoridad del lanzador)", () => {
    const { game, balls, sounds } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    game.applyRemote({ type: "hit", by: "otro", ballId: 2, hitPos: [0, 0, 0] });
    // Puntúa al lanzador remoto y suena el impacto.
    expect(game.snapshot().scores.otro).toBe(1);
    expect(sounds).toContain("hit");
    // Pero NO respawnea la pelota localmente: su nueva pos (aleatoria) llega por el
    // flujo "ball" desde el lanzador (evita doble teleport con pos divergente).
    expect(balls.respawned).toHaveLength(0);
  });

  it("el golpe LOCAL sí respawnea (el lanzador es la autoridad que difunde la pos)", () => {
    const { game, balls } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    balls.throwAt(0, 0, 0, 0); // dentro del cilindro
    game.update(0.016);
    expect(balls.respawned).toContainEqual({ id: 0, reason: "hit" });
  });

  it("applyRemote 'stop' durante running vuelve a idle", () => {
    const { game } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    game.applyRemote({ type: "stop", by: "otro" });
    expect(game.snapshot().phase).toBe("idle");
  });

  it("mergeNames es sticky y aparece en el snapshot", () => {
    const { game } = makeGame();
    game.mergeNames({ x: "Ana" });
    expect(game.snapshot().names.x).toBe("Ana");
    game.mergeNames({ x: "Ana Renombrada" });
    expect(game.snapshot().names.x).toBe("Ana Renombrada");
    // No borra ids previos al fusionar otros.
    game.mergeNames({ y: "Bruno" });
    expect(game.snapshot().names).toMatchObject({ x: "Ana Renombrada", y: "Bruno" });
  });

  it("onChange notifica en cambios de fase/score (no cada frame)", () => {
    const { game } = makeGame();
    const cb = vi.fn();
    game.onChange(cb);
    game.update(0.016); // idle, sin cambios → no notifica
    expect(cb).not.toHaveBeenCalled();
    game.start(); // cambio de fase → notifica
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("juega en solitario: primer acierto deja marcador de 1 para el local", () => {
    const { game, balls } = makeGame();
    // Sin setLocalPlayer (offline): el local es "local" por defecto.
    game.start();
    balls.throwAt(0, 0, 0, 0);
    game.update(0.016);
    expect(game.snapshot().scores.local).toBe(1);
  });
});

/**
 * FIX-RED #3 — cada cliente cierra la ronda contra SU reloj y `enterResults` congela
 * `winnerIds` UNA vez. Un "hit" (o un beacon "state") que llegara después mutaba el
 * marcador ya cerrado → dos clientes anunciaban ganadores DISTINTOS. Ahora el
 * marcador sólo se toca en "running"; el FX/sonido del golpe sí sigue siempre.
 */
describe("BallGame — el marcador se congela con los ganadores", () => {
  /** Arranca una ronda y la lleva a "results" con "me"=2 y "otro"=1. */
  function playedRound(): Harness {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = makeGame();
    h.game.setLocalPlayer("me");
    h.game.start();
    h.game.applyRemote({ type: "hit", by: "me", ballId: 1, hitPos: [0, 0, 0] });
    h.game.applyRemote({ type: "hit", by: "me", ballId: 2, hitPos: [0, 0, 0] });
    h.game.applyRemote({ type: "hit", by: "otro", ballId: 3, hitPos: [0, 0, 0] });
    vi.setSystemTime(180_001);
    h.game.update(0.016); // → results, winnerIds = ["me"]
    expect(h.game.snapshot().phase).toBe("results");
    expect(h.game.snapshot().winnerIds).toEqual(["me"]);
    return h;
  }

  it("un 'hit' TARDÍO (ya en results) NO puntúa ni cambia los ganadores", () => {
    const { game } = playedRound();
    // Dos hits rezagados de "otro" que, antes, lo habrían empatado y luego pasado.
    game.applyRemote({ type: "hit", by: "otro", ballId: 4, hitPos: [0, 0, 0] });
    game.applyRemote({ type: "hit", by: "otro", ballId: 5, hitPos: [0, 0, 0] });
    const s = game.snapshot();
    expect(s.scores).toEqual({ me: 2, otro: 1 });
    expect(s.winnerIds).toEqual(["me"]);
  });

  it("el 'hit' tardío SÍ hace su FX/sonido (el golpe ocurrió de verdad)", () => {
    const { game, sounds } = playedRound();
    const before = sounds.filter((s) => s === "hit").length;
    game.applyRemote({ type: "hit", by: "otro", ballId: 4, hitPos: [0, 0, 0] });
    expect(sounds.filter((s) => s === "hit").length).toBe(before + 1);
  });

  it("un beacon 'state' rezagado no fusiona puntos durante results", () => {
    const { game } = playedRound();
    game.applyRemote({
      type: "state",
      endsAt: 180_000,
      scores: { otro: 9 },
      startedBy: "me",
    });
    const s = game.snapshot();
    expect(s.scores.otro).toBe(1);
    expect(s.winnerIds).toEqual(["me"]);
  });

  it("un golpe LOCAL tardío tampoco puntúa en results (misma guarda de fase)", () => {
    const { game, balls } = playedRound();
    balls.throwAt(0, 0, 0, 0); // dentro del cilindro, atribuida al local
    game.update(0.016);
    expect(game.snapshot().scores).toEqual({ me: 2, otro: 1 });
    expect(game.snapshot().winnerIds).toEqual(["me"]);
  });

  it("la siguiente ronda vuelve a puntuar con normalidad (la guarda no se pega)", () => {
    const { game } = playedRound();
    vi.setSystemTime(180_001 + 8_001);
    game.update(0.016); // results → idle
    game.start();
    game.applyRemote({ type: "hit", by: "otro", ballId: 4, hitPos: [0, 0, 0] });
    expect(game.snapshot().scores.otro).toBe(1);
  });
});

/**
 * FIX-RED #6 — sin ronda activa, una pelota atribuida al local y tangente a la base
 * de Paqo re-entraba en el cilindro cada frame: chispas + deflect + vel.y+=0.4 a
 * 60 Hz durante los 4 s de la ventana de atribución. El epsilon de `Balls.deflect`
 * la saca del cilindro y este cooldown por pelota cubre que la física la devuelva.
 */
describe("BallGame — el golpe de cortesía (sin partida) tiene enfriamiento", () => {
  it("una pelota clavada en el cilindro NO dispara deflect cada frame", () => {
    const { game, balls } = makeGame();
    // El mock NO mueve la pelota al deflect: simula el peor caso (tangente que la
    // física devuelve al cilindro de inmediato).
    balls.throwAt(0, 0, 0, 0);
    for (let f = 0; f < 30; f++) game.update(0.016); // ~0.5 s a 60 fps
    expect(balls.deflected).toHaveLength(1);
  });

  it("pasado el enfriamiento, Paqo vuelve a reaccionar", () => {
    const { game, balls } = makeGame();
    balls.throwAt(0, 0, 0, 0);
    game.update(0.016);
    expect(balls.deflected).toHaveLength(1);
    game.update(0.7); // > SOFT_HIT_COOLDOWN
    game.update(0.016);
    expect(balls.deflected).toHaveLength(2);
  });

  it("el enfriamiento es POR PELOTA (otra pelota reacciona en el mismo frame)", () => {
    const { game, balls } = makeGame();
    balls.throwAt(0, 0, 0, 0);
    balls.throwAt(1, 0.2, 0, 0.2);
    game.update(0.016);
    expect(balls.deflected).toEqual([0, 1]);
  });

  it("el enfriamiento de cortesía NO frena la puntuación con partida activa", () => {
    const { game, balls } = makeGame();
    game.setLocalPlayer("me");
    game.start();
    balls.throwAt(0, 0, 0, 0);
    game.update(0.016);
    balls.throwAt(0, 0, 0, 0); // vuelve a entrar (nuevo lanzamiento)
    game.update(0.016);
    expect(game.snapshot().scores.me).toBe(2);
  });
});
