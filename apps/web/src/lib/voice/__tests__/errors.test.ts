import { describe, it, expect } from "vitest";
import {
  classifyGetUserMediaError,
  voiceErrorMessage,
  isHardVoiceError,
} from "../errors";

/** Fabrica un error-like con el `name` de un DOMException (como lanza getUserMedia). */
function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe("classifyGetUserMediaError", () => {
  it("permiso denegado → 'permission' (NotAllowedError / SecurityError / alias)", () => {
    expect(classifyGetUserMediaError(domError("NotAllowedError"))).toBe("permission");
    expect(classifyGetUserMediaError(domError("SecurityError"))).toBe("permission");
    expect(classifyGetUserMediaError(domError("PermissionDeniedError"))).toBe("permission");
  });

  it("sin micrófono → 'no-mic' (NotFoundError / OverconstrainedError / alias)", () => {
    expect(classifyGetUserMediaError(domError("NotFoundError"))).toBe("no-mic");
    expect(classifyGetUserMediaError(domError("DevicesNotFoundError"))).toBe("no-mic");
    expect(classifyGetUserMediaError(domError("OverconstrainedError"))).toBe("no-mic");
  });

  it("micrófono ocupado → 'in-use' (NotReadableError / TrackStartError)", () => {
    expect(classifyGetUserMediaError(domError("NotReadableError"))).toBe("in-use");
    expect(classifyGetUserMediaError(domError("TrackStartError"))).toBe("in-use");
  });

  it("desconocido o sin name → 'unknown' (nunca 'connection')", () => {
    expect(classifyGetUserMediaError(domError("WeirdError"))).toBe("unknown");
    expect(classifyGetUserMediaError(new Error("boom"))).toBe("unknown");
    expect(classifyGetUserMediaError(null)).toBe("unknown");
    expect(classifyGetUserMediaError({})).toBe("unknown");
  });

  it("acepta un DOMException real si el entorno lo provee", () => {
    if (typeof DOMException !== "undefined") {
      expect(classifyGetUserMediaError(new DOMException("no", "NotAllowedError"))).toBe(
        "permission"
      );
      expect(classifyGetUserMediaError(new DOMException("busy", "NotReadableError"))).toBe(
        "in-use"
      );
    }
  });
});

describe("voiceErrorMessage", () => {
  it("cada motivo de MICRÓFONO tiene su mensaje propio (no el genérico)", () => {
    expect(voiceErrorMessage("permission", false)).toMatch(/candado/i);
    expect(voiceErrorMessage("no-mic", false)).toMatch(/micrófono conectado/i);
    expect(voiceErrorMessage("in-use", false)).toMatch(/otra app/i);
    expect(voiceErrorMessage("insecure", false)).toMatch(/HTTPS/i);
    expect(voiceErrorMessage("unknown", false)).toMatch(/micrófono/i);
  });

  it("distingue conexión total (fuera) de par fallido (dentro)", () => {
    expect(voiceErrorMessage("connection", false)).toMatch(/red o servidor/i);
    expect(voiceErrorMessage("connection", true)).toMatch(/algún viajero/i);
    // El aviso de par fallido NO menciona el micrófono.
    expect(voiceErrorMessage("connection", true)).not.toMatch(/micrófono/i);
  });

  it("sin error → null", () => {
    expect(voiceErrorMessage(null, false)).toBeNull();
    expect(voiceErrorMessage(null, true)).toBeNull();
  });
});

describe("isHardVoiceError", () => {
  it("los fallos de micrófono y la conexión total son DUROS (rojo)", () => {
    expect(isHardVoiceError("permission", false)).toBe(true);
    expect(isHardVoiceError("no-mic", false)).toBe(true);
    expect(isHardVoiceError("in-use", false)).toBe(true);
    expect(isHardVoiceError("insecure", false)).toBe(true);
    expect(isHardVoiceError("unknown", false)).toBe(true);
    expect(isHardVoiceError("connection", false)).toBe(true);
  });

  it("un par P2P fallido estando DENTRO es un aviso SUAVE (no rojo)", () => {
    expect(isHardVoiceError("connection", true)).toBe(false);
  });

  it("sin error nunca es duro", () => {
    expect(isHardVoiceError(null, false)).toBe(false);
    expect(isHardVoiceError(null, true)).toBe(false);
  });
});
