/**
 * Lógica PURA de detección de "hay una versión nueva desplegada".
 *
 * Se extrae aquí (sin React ni DOM) para poder testearla en el entorno `node`
 * de vitest, igual que el resto de librerías de `lib/`. `UpdateSentinel` la
 * consume: compara su build id EMBEBIDO (inyectado en el bundle en build via
 * `process.env.NEXT_PUBLIC_BUILD_ID`) contra el que sirve `/api/version` (el del
 * despliegue vivo). Si difieren, el cliente está corriendo código viejo.
 */

/** Forma de la respuesta de /api/version. */
export interface VersionPayload {
  v?: unknown;
}

/**
 * Extrae un build id válido del JSON de /api/version. Devuelve `null` si el
 * cuerpo no tiene un `v` string no vacío (respuesta corrupta, HTML de error de
 * un proxy, etc.) — en cuyo caso NO debemos concluir nada.
 */
export function parseVersion(data: unknown): string | null {
  if (data && typeof data === "object" && "v" in data) {
    const v = (data as VersionPayload).v;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * ¿El id remoto (despliegue vivo) es DISTINTO del embebido (lo que corre el
 * cliente)? Conservador: si falta cualquiera de los dos, o son iguales,
 * devolvemos `false` — nunca molestamos al usuario sin certeza.
 */
export function isNewVersion(
  embedded: string | null | undefined,
  remote: string | null | undefined,
): boolean {
  if (!embedded || !remote) return false;
  return embedded !== remote;
}
