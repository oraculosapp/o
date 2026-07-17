import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * Regresión CRÍTICA de la voz (S11 · WebRTC P2P).
 *
 * `microphone=()` en la Permissions-Policy bloquea la feature del micrófono para
 * TODA la app: la Permissions API reporta "denied" y `useVoiceRoom` corta con
 * "Necesito permiso del micrófono…" SIN llegar a pedirlo, aunque el usuario lo
 * haya concedido en el candado 🔒 de Chrome. La voz necesita `microphone=(self)`.
 * Este test fija la cabecera para que nadie vuelva a apagarla por descuido.
 */
describe("next.config · Permissions-Policy", () => {
  it("permite el micrófono a same-origin (microphone=(self)), no lo bloquea", async () => {
    const groups = await nextConfig.headers!();
    const all = groups.flatMap((g) => g.headers);
    const perms = all.find((h) => h.key === "Permissions-Policy");

    expect(perms).toBeDefined();
    expect(perms!.value).toContain("microphone=(self)");
    // El bloqueo total nunca debe volver: `microphone=()` (paréntesis vacíos).
    expect(perms!.value).not.toMatch(/microphone=\(\)/);
  });

  it("mantiene bloqueadas las features que no usamos (cámara, geolocalización)", async () => {
    const groups = await nextConfig.headers!();
    const perms = groups
      .flatMap((g) => g.headers)
      .find((h) => h.key === "Permissions-Policy");

    expect(perms!.value).toContain("camera=()");
    expect(perms!.value).toContain("geolocation=()");
  });
});

/**
 * Regresión CRÍTICA del captcha (Cloudflare Turnstile).
 *
 * S4d endureció la CSP y rompió Turnstile EN SILENCIO: script-src-elem bloqueaba
 * https://challenges.cloudflare.com/turnstile/v0/api.js, getCaptchaToken() agotaba
 * sus 25s y resolvía null, signInAnonymously iba sin captchaToken y Supabase
 * respondía 400 "captcha protection: request disallowed" → sin sesión anónima →
 * SIN multijugador ni voz para todo visitante nuevo. Los visitantes con sesión
 * persistida no lo notaban, por eso pasó desapercibido.
 *
 * Además el widget monta un IFRAME de challenges.cloudflare.com: sin frame-src
 * explícita el navegador cae a child-src ('self' blob:) y también lo bloquea.
 * Estos tests fijan ambas directivas para que nadie vuelva a apagarlas.
 */
describe("next.config · CSP · Cloudflare Turnstile", () => {
  const getCsp = async () => {
    const groups = await nextConfig.headers!();
    const csp = groups
      .flatMap((g) => g.headers)
      .find((h) => h.key === "Content-Security-Policy");
    expect(csp).toBeDefined();
    return csp!.value;
  };

  it("script-src permite el script de Turnstile (challenges.cloudflare.com)", async () => {
    const csp = await getCsp();
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  });

  it("frame-src existe y permite el iframe del widget de Turnstile", async () => {
    const csp = await getCsp();
    const frameSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("frame-src "));

    // Sin frame-src explícita, los iframes caen a child-src ('self' blob:) y el
    // widget queda bloqueado aunque el script cargue.
    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain("https://challenges.cloudflare.com");
  });
});
