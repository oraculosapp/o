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
