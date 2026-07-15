import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cobertura del fix del bug de producción `captcha_failed`:
 *  1. `getCaptchaToken` en entorno node (sin window) / sin site key → null.
 *  2. `ensureAnonSession` deduplica llamadas concurrentes → un solo signup.
 *  3. Un fallo de captcha de Supabase produce un error accionable (Turnstile).
 *
 * Mockeamos sólo `@supabase/supabase-js` (createClient) para controlar
 * `getSession` / `signInAnonymously`. NO mockeamos `../captcha`: en node su
 * `getCaptchaToken` real ya resuelve null (no hay `window`), que es justo el
 * comportamiento que queremos ejercitar aquí.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInAnonymously: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getSession: mocks.getSession,
      signInAnonymously: mocks.signInAnonymously,
    },
  }),
}));

// Env mínima para que getSupabaseBrowserClient() no lance al leer readEnv().
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  mocks.getSession.mockReset();
  mocks.signInAnonymously.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("getCaptchaToken", () => {
  it("resuelve null sin site key (o en SSR/node sin window)", async () => {
    const { getCaptchaToken } = await import("../captcha");
    await expect(getCaptchaToken()).resolves.toBeNull();
  });

  it("sigue resolviendo null aunque haya site key si no hay DOM (node)", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "0x4AAAAAAA-test";
    const { getCaptchaToken } = await import("../captcha");
    // En node `window`/`document` no existen: no debe colgarse ni lanzar.
    await expect(getCaptchaToken()).resolves.toBeNull();
  });
});

describe("ensureAnonSession", () => {
  it("deduplica llamadas concurrentes: un solo signInAnonymously", async () => {
    const session = { user: { id: "u1", is_anonymous: true } };
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.signInAnonymously.mockResolvedValue({ data: { session }, error: null });

    const { ensureAnonSession } = await import("../supabase");
    const [a, b] = await Promise.all([ensureAnonSession(), ensureAnonSession()]);

    expect(mocks.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(a).toBe(session);
    expect(b).toBe(session);
  });

  it("traduce un fallo de captcha en un error accionable (Turnstile / Supabase)", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.signInAnonymously.mockResolvedValue({
      data: { session: null },
      error: { message: "captcha protection: request disallowed (no captcha_token found)" },
    });

    const { ensureAnonSession } = await import("../supabase");
    await expect(ensureAnonSession()).rejects.toThrow(/Turnstile/i);
    await expect(ensureAnonSession()).rejects.toThrow(/Supabase/i);
  });

  it("reintenta tras un fallo (la promesa en vuelo se limpia)", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    mocks.signInAnonymously
      .mockResolvedValueOnce({ data: { session: null }, error: { message: "network glitch" } })
      .mockResolvedValueOnce({
        data: { session: { user: { id: "u2", is_anonymous: true } } },
        error: null,
      });

    const { ensureAnonSession } = await import("../supabase");
    await expect(ensureAnonSession()).rejects.toThrow(/network glitch/);
    // El segundo intento debe poder crear una sesión nueva (dedup ya liberado).
    await expect(ensureAnonSession()).resolves.toMatchObject({ user: { id: "u2" } });
    expect(mocks.signInAnonymously).toHaveBeenCalledTimes(2);
  });
});
