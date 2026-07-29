import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Balls, BallGame, type GameEvent } from "@phygitalia/engine";
import {
  ensureServerClock,
  getServerOffsetMs,
  isServerClockSynced,
  resetServerClock,
  serverNow,
} from "../realtime";

/**
 * RELOJES (S20) — el desempate de robos de balón y el reloj de ronda del mini-juego
 * se dirimían contra el `Date.now()` del DISPOSITIVO. Consecuencias reales:
 *
 *   · Un viajero con el reloj adelantado 40 s ROBABA SIEMPRE (su `t` ganaba todos
 *     los desempates) y era IMPOSIBLE robarle.
 *   · Adelantado más que la ronda (3 min), el filtro `endsAt > now` de la adopción
 *     por beacon nunca se cumplía: idle perpetuo mientras fusionaba puntuaciones de
 *     una partida que para él no existía.
 *
 * Ahora la capa de red deriva un OFFSET DE SERVIDOR una vez al conectar y lo inyecta
 * en el engine (`setNow`), de modo que todos comparan contra la misma referencia.
 * Aquí se cubren las dos mitades: la derivación del offset (realtime.ts) y el
 * comportamiento del engine con relojes inyectados distintos.
 */

// ---------------------------------------------------------------------------
// 1) Derivación del offset de servidor (apps/web/src/lib/realtime.ts)
// ---------------------------------------------------------------------------

/** Respuesta de mentirijillas con (o sin) cabecera `Date`. */
function fakeResponse(dateHeader: string | null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "date" ? dateHeader : null) },
  };
}

/** Cabecera `Date` (RFC 7231, resolución de SEGUNDO) para un epoch-ms dado. */
function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

describe("realtime — offset de servidor (serverNow)", () => {
  beforeEach(() => {
    resetServerClock();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetServerClock();
  });

  it("sin derivar, serverNow() es Date.now() (degradación silenciosa)", () => {
    expect(getServerOffsetMs()).toBe(0);
    expect(isServerClockSynced()).toBe(false);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
  });

  it("deriva el desfase de un dispositivo ADELANTADO 40 s y corrige serverNow()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000); // reloj del dispositivo
    // El servidor va 40 s por detrás del dispositivo → offset ≈ −40 s.
    const serverMs = 1_000_000_000_000 - 40_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(httpDate(serverMs)))
    );

    await ensureServerClock();

    expect(isServerClockSynced()).toBe(true);
    // Tolerancia: la cabecera Date trunca a segundos (compensamos con +500 ms).
    expect(getServerOffsetMs()).toBeGreaterThan(-41_000);
    expect(getServerOffsetMs()).toBeLessThan(-39_000);
    expect(Math.abs(serverNow() - serverMs)).toBeLessThan(1_000);
  });

  it("deriva el desfase de un dispositivo ATRASADO (offset positivo)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const serverMs = 1_000_000_000_000 + 90_000; // servidor 90 s por delante
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(httpDate(serverMs)))
    );

    await ensureServerClock();

    expect(getServerOffsetMs()).toBeGreaterThan(89_000);
    expect(getServerOffsetMs()).toBeLessThan(91_000);
  });

  it("una vez derivado no se vuelve a pedir; ensureServerClock() concurrente dedupe", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(httpDate(Date.now())));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([ensureServerClock(), ensureServerClock(), ensureServerClock()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await ensureServerClock(); // ya sincronizado: ni un fetch más
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("si el fetch FALLA, offset 0 y reintento perezoso en la próxima conexión", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureServerClock();
    expect(getServerOffsetMs()).toBe(0); // comportamiento de siempre (Date.now)
    expect(isServerClockSynced()).toBe(false);
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);

    // La siguiente reconexión vuelve a intentarlo (no se queda tostado).
    await ensureServerClock();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("sin cabecera Date legible (CORS raro) se queda en offset 0 y reintenta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => fakeResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    await ensureServerClock();
    expect(isServerClockSynced()).toBe(false);
    expect(getServerOffsetMs()).toBe(0);

    await ensureServerClock();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("una cabecera Date basura no envenena el reloj", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse("no-soy-una-fecha"))
    );
    await ensureServerClock();
    expect(getServerOffsetMs()).toBe(0);
    expect(isServerClockSynced()).toBe(false);
  });

  it("descarta un offset DISPARATADO (>12 h): probablemente la cabecera miente", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(httpDate(1_000_000_000_000 + 20 * 3_600_000)))
    );
    await ensureServerClock();
    expect(getServerOffsetMs()).toBe(0);
    expect(isServerClockSynced()).toBe(false);
  });

  it("descarta la muestra si el RTT es enorme (estimación sin valor)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            // 9 s de ida y vuelta: por encima del tope de 8 s.
            setTimeout(() => resolve(fakeResponse(httpDate(Date.now() - 40_000))), 9_000);
          })
      )
    );

    const p = ensureServerClock();
    await vi.advanceTimersByTimeAsync(9_000);
    await p;

    expect(getServerOffsetMs()).toBe(0);
    expect(isServerClockSynced()).toBe(false);
  });

  it("sin Supabase configurado no se intenta nada (ni fetch ni ruido)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await ensureServerClock();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getServerOffsetMs()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2) El engine con relojes inyectados distintos (dos clientes desfasados)
// ---------------------------------------------------------------------------

/** Campo plano de prueba (altura 0, normal vertical, claro a nivel 1). */
const flatField = {
  heightAt: () => 0,
  surfaceNormal: (_x: number, _z: number, out?: THREE.Vector3) =>
    (out ?? new THREE.Vector3()).set(0, 1, 0),
  insideIsland: () => true,
  clearLevel: 1,
};

/** Reloj mundial compartido de la simulación (lo que marcaría un reloj atómico). */
let wall = 1_000_000;

interface Client {
  id: string;
  balls: Balls;
}

/**
 * Un cliente con SU reloj. `now` es lo que el engine usa para sellar agarres: con
 * el fix es `serverNow` (todos coinciden); sin él, el `Date.now()` del dispositivo
 * (cada uno el suyo, con su desfase).
 */
function client(id: string, now: () => number): Client {
  const balls = new Balls(flatField as never, now);
  balls.build();
  balls.setLocalId(id);
  return { id, balls };
}

/**
 * `c` agarra el balón y el canal difunde su "ball_grab" al resto (como haría
 * Supabase Realtime). Devuelve el `t` que salió por el cable.
 */
function grabAndBroadcast(c: Client, ballId: number, others: Client[]): number {
  let sent = Number.NaN;
  const off = c.balls.onGrab((_id, t) => {
    sent = t;
  });
  c.balls.grab(ballId);
  off();
  for (const o of others) o.balls.applyGrab(ballId, c.id, sent);
  return sent;
}

describe("Balls — robo de balón entre clientes con relojes desfasados", () => {
  beforeEach(() => {
    wall = 1_000_000;
  });

  /** El fix: ambos clientes corrigen con su offset → los dos ven la hora real. */
  function fixedPair(): { ahead: Client; ontime: Client } {
    // "ahead" tiene el dispositivo 40 s adelantado, pero su offset lo compensa.
    return {
      ahead: client("aaa-adelantado", () => wall + 40_000 - 40_000),
      ontime: client("zzz-en-hora", () => wall),
    };
  }

  it("el que agarra DESPUÉS se queda el balón, aunque su dispositivo vaya en hora", () => {
    const { ahead, ontime } = fixedPair();
    wall = 1_000_000;
    grabAndBroadcast(ahead, 0, [ontime]); // el adelantado agarra primero
    expect(ahead.balls.isHolding()).toBe(true);

    wall = 1_030_000; // 30 s después, el otro se lo roba
    grabAndBroadcast(ontime, 0, [ahead]);

    expect(ontime.balls.heldBall()).toBe(0);
    expect(ahead.balls.isHolding()).toBe(false); // force-drop silencioso: SÍ se le puede robar
  });

  it("y al revés: el adelantado también puede robar cuando de verdad agarra después", () => {
    const { ahead, ontime } = fixedPair();
    wall = 1_000_000;
    grabAndBroadcast(ontime, 0, [ahead]);
    wall = 1_030_000;
    grabAndBroadcast(ahead, 0, [ontime]);

    expect(ahead.balls.heldBall()).toBe(0);
    expect(ontime.balls.isHolding()).toBe(false);
  });

  it("REGRESIÓN: con el reloj del DISPOSITIVO (sin offset) el adelantado era inmune", () => {
    // Exactamente el bug: cada uno sella con su Date.now() sin corregir.
    const ahead = client("aaa-adelantado", () => wall + 40_000);
    const ontime = client("zzz-en-hora", () => wall);

    wall = 1_000_000;
    grabAndBroadcast(ahead, 0, [ontime]); // agarra PRIMERO, con t = wall+40 s
    wall = 1_030_000; // 30 s reales después…
    grabAndBroadcast(ontime, 0, [ahead]); // …intenta robárselo con t = wall

    // El ladrón se cree con el balón pero la víctima NO lo suelta: doble portador.
    expect(ahead.balls.isHolding()).toBe(true); // ← el fallo que arreglamos
    expect(ontime.balls.heldBall()).toBe(0);
  });

  it("el empate exacto sigue resolviéndose por id lexicográfico menor", () => {
    const { ahead, ontime } = fixedPair(); // "aaa-adelantado" < "zzz-en-hora"
    wall = 1_000_000;
    grabAndBroadcast(ontime, 0, [ahead]);
    // Mismo instante de servidor: gana "aaa-adelantado" por id.
    grabAndBroadcast(ahead, 0, [ontime]);
    expect(ontime.balls.isHolding()).toBe(false);
    expect(ahead.balls.heldBall()).toBe(0);
  });

  it("la auto-cura del doble portador (flujo 'ball') usa el MISMO reloj corregido", () => {
    const { ahead, ontime } = fixedPair();
    wall = 1_000_000;
    grabAndBroadcast(ontime, 0, []); // el "ball_grab" se pierde por el camino
    wall = 1_030_000;
    const t = grabAndBroadcast(ahead, 0, []); // …y el del ladrón también

    // Sólo llega el paquete "ball" periódico del portador nuevo: debe curar.
    ontime.balls.applyState(0, {
      pos: [12, 1.15, 0],
      vel: [0, 0, 0],
      heldBy: ahead.id,
      grabT: t,
    });
    expect(ontime.balls.isHolding()).toBe(false);
  });

  it("DEGRADACIÓN: si la derivación falla (offset 0 en ambos), se comporta como antes", () => {
    // Dos clientes nuevos sin offset derivado = dos relojes de dispositivo en hora:
    // el desempate sigue funcionando igual de bien que siempre.
    const a = client("aaa", () => wall);
    const b = client("bbb", () => wall);
    wall = 1_000_000;
    grabAndBroadcast(a, 0, [b]);
    wall = 1_001_000;
    grabAndBroadcast(b, 0, [a]);
    expect(b.balls.heldBall()).toBe(0);
    expect(a.balls.isHolding()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3) El reloj de RONDA del mini-juego con desfases de minutos
// ---------------------------------------------------------------------------

/** Mock mínimo de Balls para BallGame (sin WebGL): nunca hay pelotas vivas. */
class NoBalls {
  count = 0;
  onRespawn(): () => void {
    return () => {};
  }
  isLiveByLocal(): boolean {
    return false;
  }
  positionOf(_id: number, out: THREE.Vector3): THREE.Vector3 {
    return out;
  }
  respawnToHome(): void {}
  deflect(): void {}
}

function makeGame(now: () => number): BallGame {
  return new BallGame({
    scene: new THREE.Scene(),
    balls: new NoBalls() as unknown as never,
    field: {} as never,
    getTotem: () => null,
    onSound: () => {},
    now,
  });
}

describe("BallGame — adopción de ronda con el reloj desfasado", () => {
  beforeEach(() => {
    wall = 1_000_000;
  });

  /** Beacon "state" tal cual lo emitiría el que arrancó la partida (hora servidor). */
  function beacon(endsAt: number): GameEvent {
    return { type: "state", endsAt, scores: { anfitrion: 3 }, startedBy: "anfitrion" };
  }

  it("un dispositivo adelantado 5 MINUTOS adopta la ronda igual que los demás", () => {
    // Su Date.now() marca wall+300 s, pero su offset lo compensa.
    const game = makeGame(() => wall + 300_000 - 300_000);
    game.applyRemote(beacon(wall + 120_000)); // quedan 2 min de ronda
    const s = game.snapshot();
    expect(s.phase).toBe("running");
    expect(s.endsAt).toBe(wall + 120_000);
    expect(s.scores).toEqual({ anfitrion: 3 });
  });

  it("REGRESIÓN: con el reloj del dispositivo se quedaba en idle perpetuo", () => {
    const game = makeGame(() => wall + 300_000); // 5 min adelantado, SIN corregir
    game.applyRemote(beacon(wall + 120_000));
    // Para él la ronda "ya terminó": no la adopta… pero sí fusiona el marcador.
    expect(game.snapshot().phase).toBe("idle");
    expect(game.snapshot().scores).toEqual({ anfitrion: 3 });
  });

  it("un dispositivo ATRASADO 5 min tampoco alarga la ronda: cierra a la hora", () => {
    const game = makeGame(() => wall - 300_000 + 300_000);
    game.applyRemote(beacon(wall + 10_000));
    expect(game.snapshot().phase).toBe("running");

    wall += 10_001; // pasa la hora REAL de fin
    game.update(0.016);
    expect(game.snapshot().phase).toBe("results");
  });

  it("dos clientes con dispositivos opuestos terminan la ronda en el MISMO instante", () => {
    const adelantado = makeGame(() => wall + 40_000 - 40_000);
    const atrasado = makeGame(() => wall - 25_000 + 25_000);
    const endsAt = wall + 30_000;
    adelantado.applyRemote(beacon(endsAt));
    atrasado.applyRemote(beacon(endsAt));

    wall += 29_000;
    adelantado.update(0.016);
    atrasado.update(0.016);
    expect(adelantado.snapshot().phase).toBe("running");
    expect(atrasado.snapshot().phase).toBe("running");

    wall += 2_000;
    adelantado.update(0.016);
    atrasado.update(0.016);
    expect(adelantado.snapshot().phase).toBe("results");
    expect(atrasado.snapshot().phase).toBe("results");
  });

  it("el `endsAt` que EMITE start() sale del reloj corregido (lo consumen los demás)", () => {
    const events: GameEvent[] = [];
    const game = makeGame(() => wall + 40_000 - 40_000);
    game.onLocalEvent((e) => events.push(e));
    game.start();
    // 3 min de ronda contados desde la hora de SERVIDOR, no desde la del cacharro.
    expect(events.at(-1)).toMatchObject({ type: "start", endsAt: wall + 180_000 });
  });
});
