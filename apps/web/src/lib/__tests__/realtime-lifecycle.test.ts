import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ciclo de vida de {@link BiosphereRealtime}: dos regresiones de prod.
 *
 *   1. PRESENCIA FANTASMA — al caerse el canal (CHANNEL_ERROR / TIMED_OUT) sólo se
 *      emitía `onStatus("error")`: el roster (la insignia "General N" del chat) se
 *      quedaba con el conteo VIEJO para siempre, mientras los avatares 3D sí se
 *      retiraban por el barrido de 5 s. Además `presentIds` seguía dando por buenos
 *      los broadcasts de gente que ya no estaba (el guard anti-griefing de M-5).
 *      Se comprueba también que la limpieza es TRANSITORIA: si el canal se recupera
 *      en caliente, el "presence sync" siguiente repuebla el roster.
 *
 *   2. ESPERA COLGADA — el backoff de sesión se cancelaba con `clearTimeout` a secas,
 *      sin resolver la promesa de `delay()`, así que el `connect()` en vuelo quedaba
 *      suspendido PARA SIEMPRE reteniendo la instancia (canal, callbacks y getters
 *      del mundo). Ahora la espera es cancelable y el intento viejo se retira.
 *
 * Todo se testea en node con dobles: mockeamos `../supabase` (sesión + cliente) y
 * un canal de Supabase de mentirijillas que nos deja disparar los estados de
 * `subscribe()` y el evento de presence a mano.
 */

const ensureAnonSession = vi.fn();
const getSupabaseBrowserClient = vi.fn();

vi.mock("../supabase", () => ({
  ensureAnonSession: () => ensureAnonSession(),
  getSupabaseBrowserClient: () => getSupabaseBrowserClient(),
}));

import { BiosphereRealtime, type RosterMember, type WorldNetHooks } from "../realtime";

type PresenceMeta = { id: string; display_name: string; tint?: string; archetype?: string };

/** Canal de Supabase de mentirijillas: guarda los handlers y los dispara a mano. */
class FakeChannel {
  presence: Record<string, PresenceMeta[]> = {};
  syncCb: (() => void) | null = null;
  broadcastCbs = new Map<string, (arg: { payload: unknown }) => void>();
  statusCb: ((status: string) => void) | null = null;
  tracked: PresenceMeta[] = [];

  on(type: string, filter: { event?: string }, cb: (arg: never) => void): this {
    if (type === "presence" && filter.event === "sync") {
      this.syncCb = cb as unknown as () => void;
    } else if (type === "broadcast" && filter.event) {
      this.broadcastCbs.set(filter.event, cb as unknown as (arg: { payload: unknown }) => void);
    }
    return this;
  }

  presenceState(): Record<string, PresenceMeta[]> {
    return this.presence;
  }

  subscribe(cb: (status: string) => void): this {
    this.statusCb = cb;
    return this;
  }

  track(meta: PresenceMeta): Promise<string> {
    this.tracked.push(meta);
    return Promise.resolve("ok");
  }

  send(): Promise<string> {
    return Promise.resolve("ok");
  }

  /** Publica un estado de presence y dispara el "sync" (como haría el servidor). */
  syncPresence(metas: PresenceMeta[]): void {
    this.presence = Object.fromEntries(metas.map((m) => [m.id, [m]]));
    this.syncCb?.();
  }
}

/** Sesión mínima con la forma que `establish()` consume. */
function fakeSession(id = "yo") {
  return { user: { id, is_anonymous: true }, access_token: "token" };
}

/** `world.net` mínimo: sólo lo que se engancha en `wireWorldNet`. */
function fakeNet() {
  const upsertRemote = vi.fn();
  const removeRemote = vi.fn();
  const net: WorldNetHooks = {
    getLocalState: () => ({ pos: [0, 0, 0], yaw: 0, anim: "idle" }),
    onLocalTick: () => () => {},
    upsertRemote,
    removeRemote,
    onBallKick: () => () => {},
    applyBallState: () => {},
    onZoneSignal: () => () => {},
  };
  return { net, upsertRemote, removeRemote };
}

let channels: FakeChannel[] = [];

beforeEach(() => {
  channels = [];
  ensureAnonSession.mockReset();
  getSupabaseBrowserClient.mockReset();
  getSupabaseBrowserClient.mockImplementation(() => ({
    channel: () => {
      const ch = new FakeChannel();
      channels.push(ch);
      return ch;
    },
    removeChannel: () => Promise.resolve("ok"),
  }));
  // `storageHealthy()` exige un localStorage que acepte set/remove.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BiosphereRealtime — roster de presence", () => {
  it("vacía el roster al caerse el canal y lo repuebla si se recupera", async () => {
    ensureAnonSession.mockResolvedValue(fakeSession());
    const { net, upsertRemote } = fakeNet();
    const rosters: RosterMember[][] = [];
    const statuses: string[] = [];

    const rt = new BiosphereRealtime({
      biosphereId: "paqo",
      displayName: "Julio",
      tint: "#fff",
      getWorldNet: () => net,
      onRoster: (m) => rosters.push(m),
      onStatus: (s) => statuses.push(s),
    });

    await rt.connect();
    const ch = channels[0];
    expect(ch).toBeDefined();

    ch.statusCb?.("SUBSCRIBED");
    ch.syncPresence([
      { id: "yo", display_name: "Julio" },
      { id: "otra", display_name: "Viajera" },
    ]);
    expect(rosters.at(-1)).toHaveLength(2);

    // Se cae el canal: el roster deja de ser fiable → se vacía (antes se quedaba
    // con el conteo viejo para siempre en la insignia "General N").
    ch.statusCb?.("CHANNEL_ERROR");
    expect(statuses.at(-1)).toBe("error");
    expect(rosters.at(-1)).toEqual([]);

    // …y el guard anti-griefing deja de aceptar broadcasts de los que ya no están.
    ch.broadcastCbs.get("pos")?.({
      payload: { id: "otra", pos: [1, 2, 3], yaw: 0, anim: "walk" },
    });
    expect(upsertRemote).not.toHaveBeenCalled();

    // Recuperación en caliente: re-SUBSCRIBED → track() + presence sync repueblan.
    ch.statusCb?.("SUBSCRIBED");
    ch.syncPresence([
      { id: "yo", display_name: "Julio" },
      { id: "otra", display_name: "Viajera" },
    ]);
    expect(rosters.at(-1)).toHaveLength(2);
    ch.broadcastCbs.get("pos")?.({
      payload: { id: "otra", pos: [1, 2, 3], yaw: 0, anim: "walk" },
    });
    expect(upsertRemote).toHaveBeenCalledTimes(1);

    rt.disconnect();
  });

  it("vacía el roster al desconectar", async () => {
    ensureAnonSession.mockResolvedValue(fakeSession());
    const { net } = fakeNet();
    const rosters: RosterMember[][] = [];

    const rt = new BiosphereRealtime({
      biosphereId: "paqo",
      displayName: "Julio",
      tint: "#fff",
      getWorldNet: () => net,
      onRoster: (m) => rosters.push(m),
    });

    await rt.connect();
    const ch = channels[0];
    ch.statusCb?.("SUBSCRIBED");
    ch.syncPresence([{ id: "yo", display_name: "Julio" }]);
    expect(rosters.at(-1)).toHaveLength(1);

    rt.disconnect();
    expect(rosters.at(-1)).toEqual([]);
  });
});

describe("BiosphereRealtime — backoff de sesión cancelable", () => {
  it("resuelve el connect() en vuelo al desconectar durante el backoff", async () => {
    vi.useFakeTimers();
    ensureAnonSession.mockRejectedValue(new Error("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rt = new BiosphereRealtime({ biosphereId: "paqo", displayName: "Julio", tint: "#fff" });

    let settled = false;
    const p = rt.connect().then(() => {
      settled = true;
    });

    // Falla el 1er intento y queda armado el backoff de 2 s.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(ensureAnonSession).toHaveBeenCalledTimes(1);

    // Desconectar durante la espera: antes sólo se limpiaba el timer y este await
    // quedaba colgado para siempre (fuga de la instancia entera).
    rt.disconnect();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);

    // Y no se intenta nada más tras disponer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensureAnonSession).toHaveBeenCalledTimes(1);

    await p;
    warn.mockRestore();
  });

  it("retryConnect() durante el backoff no deja un segundo intento en paralelo", async () => {
    vi.useFakeTimers();
    ensureAnonSession.mockRejectedValueOnce(new Error("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const statuses: string[] = [];

    const rt = new BiosphereRealtime({
      biosphereId: "paqo",
      displayName: "Julio",
      tint: "#fff",
      onStatus: (s) => statuses.push(s),
    });

    const first = rt.connect();
    await vi.advanceTimersByTimeAsync(1); // 1er intento fallido → backoff armado

    // El viajero pulsa "Reintentar" mientras dormíamos el backoff.
    ensureAnonSession.mockResolvedValue(fakeSession());
    await rt.retryConnect();
    await first; // el intento viejo se retira en silencio (antes: colgado)

    expect(channels).toHaveLength(1);
    expect(rt.getIdentity()?.sessionId).toBe("yo");

    // Pasado de largo el backoff viejo NO aparece un segundo canal ni un "error".
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channels).toHaveLength(1);
    expect(statuses).not.toContain("error");

    rt.disconnect();
    warn.mockRestore();
  });
});
