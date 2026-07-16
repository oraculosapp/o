import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cobertura del DIAGNÓSTICO del fallo de sesión anónima (bug de prod en el
 * teléfono de Julio: en incógnito la sesión anónima falla → sin presencia ni voz):
 *   1. `describeSessionError` categoriza el motivo en captcha / red / otro y arma
 *      un mensaje AMABLE (con código corto para leer por teléfono en "otro").
 *   2. `storageHealthy` detecta almacenamiento/cookies bloqueados (incógnito).
 *
 * Ambas son puras (sin red) → se testean en node. `storageHealthy` lee los globals
 * `navigator`/`localStorage`; los stubbeamos con `vi.stubGlobal`.
 */

import { describeSessionError, storageHealthy, STORAGE_SESSION_ERROR } from "../realtime";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeSessionError", () => {
  it("clasifica un fallo de captcha/Turnstile como categoría captcha", () => {
    const info = describeSessionError(
      new Error(
        "No se pudo iniciar sesión anónima: Turnstile rechazó la petición (captcha)."
      )
    );
    expect(info.category).toBe("captcha");
    expect(info.message).toMatch(/anti-bots/i);
    expect(info.code).toBeUndefined();
  });

  it("clasifica 'captcha_failed' (sin Turnstile) como captcha", () => {
    const info = describeSessionError(new Error("captcha protection: request disallowed"));
    expect(info.category).toBe("captcha");
  });

  it("clasifica un 'Failed to fetch' como categoría red", () => {
    const info = describeSessionError(new TypeError("Failed to fetch"));
    expect(info.category).toBe("red");
    expect(info.message).toMatch(/servidor/i);
  });

  it("clasifica 'network request failed' como red", () => {
    const info = describeSessionError(new Error("AuthRetryableFetchError: network request failed"));
    expect(info.category).toBe("red");
  });

  it("cae en 'otro' con un código corto legible cuando el motivo no encaja", () => {
    const info = describeSessionError(new Error("boom raro del backend"));
    expect(info.category).toBe("otro");
    expect(info.code).toBe("boom raro del backend");
    expect(info.message).toContain("(boom raro del backend)");
  });

  it("trunca el código de 'otro' a ≤80 chars (y colapsa espacios)", () => {
    const long = "x".repeat(200);
    const info = describeSessionError(new Error(long));
    expect(info.category).toBe("otro");
    expect(info.code).toBeDefined();
    expect(info.code!.length).toBeLessThanOrEqual(80);
  });

  it("con un error sin mensaje da un genérico sin código", () => {
    const info = describeSessionError(undefined);
    expect(info.category).toBe("otro");
    expect(info.code).toBeUndefined();
    expect(info.message).toMatch(/No pudimos preparar tu sesión/i);
    expect(info.message).not.toContain("(");
  });

  it("acepta también error-like como string u objeto {message}", () => {
    expect(describeSessionError("captcha_failed").category).toBe("captcha");
    expect(describeSessionError({ message: "Failed to fetch" }).category).toBe("red");
  });
});

describe("STORAGE_SESSION_ERROR", () => {
  it("es la categoría storage con el mensaje de incógnito accionable", () => {
    expect(STORAGE_SESSION_ERROR.category).toBe("storage");
    expect(STORAGE_SESSION_ERROR.message).toMatch(/incógnito/i);
    expect(STORAGE_SESSION_ERROR.message).toMatch(/pesta[ñn]a normal/i);
  });
});

describe("storageHealthy", () => {
  it("true cuando localStorage funciona y las cookies están habilitadas", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("navigator", { cookieEnabled: true });
    vi.stubGlobal("localStorage", {
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      getItem: (k: string) => store.get(k) ?? null,
    });
    expect(storageHealthy()).toBe(true);
    // El probe no debe dejar basura.
    expect(store.size).toBe(0);
  });

  it("false cuando localStorage.setItem lanza (incógnito / cuota bloqueada)", () => {
    vi.stubGlobal("navigator", { cookieEnabled: true });
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new DOMException("bloqueado", "SecurityError");
      },
      removeItem: () => {},
    });
    expect(storageHealthy()).toBe(false);
  });

  it("false cuando navigator.cookieEnabled es false (cookies bloqueadas)", () => {
    vi.stubGlobal("navigator", { cookieEnabled: false });
    vi.stubGlobal("localStorage", {
      setItem: () => {},
      removeItem: () => {},
    });
    expect(storageHealthy()).toBe(false);
  });

  it("false cuando no hay localStorage en absoluto", () => {
    vi.stubGlobal("navigator", { cookieEnabled: true });
    vi.stubGlobal("localStorage", undefined);
    expect(storageHealthy()).toBe(false);
  });
});
