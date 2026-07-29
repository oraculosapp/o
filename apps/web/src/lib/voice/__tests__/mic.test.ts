import { describe, it, expect } from "vitest";
import {
  MIC_CONSTRAINTS,
  MIC_RELEASE_GRACE_MS,
  isMicErrorReason,
  replaceTrackOnSenders,
  stopMicStream,
} from "../mic";

/**
 * Dobles mínimos de la API de medios. El entorno de tests es node (sin DOM), así que
 * fabricamos objetos con la forma justa que consumen las funciones y los casteamos:
 * lo que se prueba es la LÓGICA (parar todo, tolerar fallos, inyectar en cada par),
 * no el navegador.
 */
function fakeTrack(kind: "audio" | "video" = "audio", onStop?: () => void) {
  return {
    kind,
    enabled: true,
    stopped: false,
    stop() {
      if (onStop) onStop();
      this.stopped = true;
    },
  };
}

type FakeTrack = ReturnType<typeof fakeTrack>;

function fakeStream(tracks: FakeTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

function fakeSender(opts: { failing?: boolean } = {}) {
  const calls: (MediaStreamTrack | null)[] = [];
  return {
    calls,
    track: null as MediaStreamTrack | null,
    async replaceTrack(track: MediaStreamTrack | null) {
      calls.push(track);
      if (opts.failing) throw new Error("InvalidStateError: sender cerrado");
      this.track = track;
    },
  };
}

const asSender = (s: ReturnType<typeof fakeSender>) => s as unknown as RTCRtpSender;
const asTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;

describe("MIC_CONSTRAINTS — constraints EXPLÍCITAS de captura", () => {
  it("pide audio como OBJETO, nunca `audio: true` (los defaults no están garantizados)", () => {
    expect(MIC_CONSTRAINTS.audio).not.toBe(true);
    expect(typeof MIC_CONSTRAINTS.audio).toBe("object");
  });

  it("activa explícitamente AEC + supresión de ruido + control de ganancia", () => {
    const audio = MIC_CONSTRAINTS.audio as MediaTrackConstraints;
    // El AEC es la primera línea contra el eco entre dos viajeros del mismo cuarto.
    expect(audio.echoCancellation).toBe(true);
    expect(audio.noiseSuppression).toBe(true);
    expect(audio.autoGainControl).toBe(true);
  });

  it("NUNCA pide cámara", () => {
    expect(MIC_CONSTRAINTS.video).toBe(false);
  });
});

describe("MIC_RELEASE_GRACE_MS — gracia mute → soltar el micro", () => {
  it("es corta pero real: absorbe el toggle nervioso sin dejar el micro abierto", () => {
    expect(MIC_RELEASE_GRACE_MS).toBeGreaterThan(0);
    expect(MIC_RELEASE_GRACE_MS).toBeLessThanOrEqual(3000);
  });
});

describe("stopMicStream", () => {
  it("para TODAS las pistas del stream (ahí se apaga el indicador de captura)", () => {
    const tracks = [fakeTrack("audio"), fakeTrack("audio")];
    stopMicStream(fakeStream(tracks));
    expect(tracks.every((t) => t.stopped)).toBe(true);
  });

  it("tolera null/undefined (liberación idempotente)", () => {
    expect(() => stopMicStream(null)).not.toThrow();
    expect(() => stopMicStream(undefined)).not.toThrow();
  });

  it("una pista que revienta al pararse no impide parar el resto", () => {
    const boom = fakeTrack("audio", () => {
      throw new Error("ya estaba muerta");
    });
    const ok = fakeTrack("audio");
    stopMicStream(fakeStream([boom, ok]));
    expect(ok.stopped).toBe(true);
  });
});

describe("replaceTrackOnSenders", () => {
  it("inyecta la pista en el carril de CADA par y cuenta los aceptados", async () => {
    const a = fakeSender();
    const b = fakeSender();
    const track = asTrack(fakeTrack("audio"));
    const ok = await replaceTrackOnSenders([asSender(a), asSender(b)], track);
    expect(ok).toBe(2);
    expect(a.track).toBe(track);
    expect(b.track).toBe(track);
  });

  it("retira la pista con null (mutear de verdad, sin renegociar)", async () => {
    const s = fakeSender();
    await replaceTrackOnSenders([asSender(s)], asTrack(fakeTrack("audio")));
    const ok = await replaceTrackOnSenders([asSender(s)], null);
    expect(ok).toBe(1);
    expect(s.track).toBeNull();
    expect(s.calls).toEqual([expect.anything(), null]);
  });

  it("un par que falla (cerrándose) NO arrastra al resto de la malla", async () => {
    const bad = fakeSender({ failing: true });
    const good = fakeSender();
    const track = asTrack(fakeTrack("audio"));
    const ok = await replaceTrackOnSenders([asSender(bad), asSender(good)], track);
    expect(ok).toBe(1);
    expect(good.track).toBe(track);
  });

  it("ignora huecos y senders sin replaceTrack (par sin transceptor)", async () => {
    const good = fakeSender();
    const ok = await replaceTrackOnSenders(
      [null, undefined, {} as unknown as RTCRtpSender, asSender(good)],
      asTrack(fakeTrack("audio"))
    );
    expect(ok).toBe(1);
  });

  it("sin pares todavía → 0 y sin explotar", async () => {
    expect(await replaceTrackOnSenders([], asTrack(fakeTrack("audio")))).toBe(0);
  });
});

describe("isMicErrorReason", () => {
  it("los fallos de MICRÓFONO se reconocen como tales", () => {
    expect(isMicErrorReason("permission")).toBe(true);
    expect(isMicErrorReason("no-mic")).toBe(true);
    expect(isMicErrorReason("in-use")).toBe(true);
    expect(isMicErrorReason("insecure")).toBe(true);
    expect(isMicErrorReason("unknown")).toBe(true);
  });

  it("un aviso de CONEXIÓN no es de micro: desmutear bien no debe borrarlo", () => {
    expect(isMicErrorReason("connection")).toBe(false);
  });

  it("sin error → false", () => {
    expect(isMicErrorReason(null)).toBe(false);
  });
});
