/**
 * Categorización de fallos de la VOZ para dar mensajes HONESTOS al viajero.
 *
 * El `join()` de la voz puede fallar por causas MUY distintas y hasta ahora todas
 * caían en el mismo mensaje engañoso ("revisa el permiso del micrófono"). Aquí
 * separamos la CAUSA real: un fallo de `getUserMedia` (permiso/hardware) no es lo
 * mismo que un fallo de señalización/negociación P2P (red/servidor).
 *
 * Funciones PURAS, sin DOM ni red → se testean en entorno node (ver __tests__).
 */

/**
 * Motivo del fallo de la voz, para que la UI muestre el mensaje correcto:
 *   · "permission" — el usuario negó (o tiene denegado) el micrófono.
 *   · "no-mic"     — no hay micrófono conectado.
 *   · "in-use"     — el micrófono está ocupado por otra app.
 *   · "insecure"   — contexto no seguro (sin HTTPS) o API no disponible.
 *   · "connection" — el micro fue bien, pero falló la señalización/negociación P2P
 *                    (Supabase caído, red restrictiva sin TURN, etc.).
 *   · "unknown"    — fallo de micrófono no clasificado.
 *   · null         — sin error.
 */
export type VoiceErrorReason =
  | "permission"
  | "no-mic"
  | "in-use"
  | "insecure"
  | "connection"
  | "unknown"
  | null;

/** Lee `.name` de un error-like (DOMException o Error) de forma segura. */
function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name: unknown }).name);
  }
  return "";
}

/**
 * Clasifica el error lanzado por `navigator.mediaDevices.getUserMedia`.
 * Mapea los `DOMException.name` (incluidos alias heredados de navegadores viejos)
 * a un `VoiceErrorReason`. Un nombre desconocido cae en "unknown" (mensaje genérico
 * de micrófono), NUNCA en "connection": si getUserMedia falló, el problema es el
 * micro/permiso, no la red.
 */
export function classifyGetUserMediaError(err: unknown): VoiceErrorReason {
  switch (errorName(err)) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError": // alias heredado (Chrome viejo)
      return "permission";
    case "NotFoundError":
    case "DevicesNotFoundError": // alias heredado
    case "OverconstrainedError": // pedimos audio simple; en la práctica = sin micro
      return "no-mic";
    case "NotReadableError":
    case "TrackStartError": // alias heredado
      return "in-use";
    default:
      return "unknown";
  }
}

/**
 * Mensaje visible (español) para cada motivo. Centralizado para que UI y tests
 * compartan una única fuente de verdad. `joined` distingue el caso de "conectado
 * pero con un par fallido" (aviso suave) del fallo total de conexión.
 */
export function voiceErrorMessage(reason: VoiceErrorReason, joined: boolean): string | null {
  switch (reason) {
    case "permission":
      return "Necesito permiso del micrófono: actívalo en el candado 🔒 de la barra de direcciones y reintenta.";
    case "no-mic":
      return "No encontré un micrófono conectado.";
    case "in-use":
      return "Tu micrófono está en uso por otra app.";
    case "insecure":
      return "La voz necesita una conexión segura (HTTPS).";
    case "connection":
      return joined
        ? "Conectado. No pude establecer audio con algún viajero (red restrictiva)."
        : "No se pudo conectar la voz (red o servidor). Reintenta.";
    case "unknown":
      return "No pude acceder al micrófono. Reintenta.";
    default:
      return null;
  }
}

/**
 * ¿Es un fallo DURO (rojo) o un aviso suave? Un par P2P fallido estando ya
 * conectado NO es un error rojo total (tienes voz, sólo no oyes a un viajero).
 */
export function isHardVoiceError(reason: VoiceErrorReason, joined: boolean): boolean {
  if (reason === null) return false;
  if (reason === "connection" && joined) return false; // aviso suave
  return true;
}
