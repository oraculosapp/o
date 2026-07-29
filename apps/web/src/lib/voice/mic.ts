/**
 * Ciclo de vida del MICRÓFONO local de la voz: constraints de captura, ventana de
 * gracia al mutear e inyección/retirada de la pista en los pares de la malla.
 *
 * Aquí viven las piezas que NO dependen de React ni del DOM del hook, para poder
 * testearlas en entorno node con dobles (ver `__tests__/mic.test.ts`). El hook
 * `useVoiceRoom` las orquesta.
 *
 * REGLA DE ORO (invariante del diseño): el micrófono está FÍSICAMENTE ABIERTO si y
 * sólo si estás DESMUTEADO. Al canal se entra muteado, así que entrar NO abre el
 * micro: el indicador de captura del navegador/SO sólo se enciende cuando de verdad
 * vas a hablar.
 */
import type { VoiceErrorReason } from "./errors";

/**
 * Constraints EXPLÍCITAS de captura del micrófono.
 *
 * Antes se pedía `{ audio: true }`. Chrome activa por defecto el trío de
 * procesamiento de voz, pero NO es así en todos los navegadores ni en todas las
 * versiones (Firefox y algunos WebView han variado sus defaults, y en un
 * `getUserMedia` sin constraints el navegador es libre de elegir). Pedirlo
 * explícitamente lo GARANTIZA:
 *
 *   · echoCancellation (AEC) — la PRIMERA LÍNEA DE DEFENSA contra el eco acústico.
 *     En Phygitalia es lo normal que dos viajeros estén en el MISMO CUARTO con los
 *     altavoces abiertos: sin AEC, el audio del otro que sale por tus altavoces
 *     vuelve a entrar por tu micro, se reenvía y realimenta (acople/eco infinito).
 *   · noiseSuppression — quita el ruido de fondo constante (ventilador, aire).
 *   · autoGainControl — nivela el volumen entre micros dispares (portátil vs casco).
 *
 * `video: false` explícito: la voz NUNCA pide cámara (nada de indicador de vídeo).
 */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

/**
 * Gracia (ms) entre MUTEAR y soltar de verdad el micrófono.
 *
 * Al mutear el silencio es INMEDIATO (`track.enabled = false`), pero la liberación
 * física se retrasa un segundo. Motivo: soltar y re-adquirir el dispositivo no es
 * gratis (el `getUserMedia` tarda entre decenas y cientos de ms, y en Bluetooth el
 * SO cambia de perfil), así que en el toggle nervioso —mutear para toser y volver—
 * destruir el stream sería peor que mantenerlo un instante. Un segundo es el
 * equilibrio: imperceptible para quien alterna, y suficientemente corto para que
 * "muteado" signifique de verdad "micro cerrado" en cuanto dejas de tocarlo.
 */
export const MIC_RELEASE_GRACE_MS = 1000;

/**
 * Para y libera TODAS las pistas de un stream local. Idempotente y tolerante: una
 * pista ya parada (o un doble `stop()`) no debe romper la limpieza del resto.
 */
export function stopMicStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* pista ya muerta: nada que hacer */
    }
  }
}

/**
 * Inyecta (o RETIRA, con `track = null`) la pista de micro en todos los senders de
 * la malla vía `RTCRtpSender.replaceTrack`.
 *
 * La clave: `replaceTrack` cambia la FUENTE de un carril RTP ya negociado, así que
 * NO dispara renegociación (nada de offer/answer nuevos por cada mute/unmute). Por
 * eso `useVoiceRoom` crea siempre un transceptor de audio por par, aunque el micro
 * esté cerrado: el carril existe desde la primera oferta y aquí sólo lo llenamos o
 * lo vaciamos.
 *
 * Tolerante por par: si uno falla (par cerrándose justo ahora), los demás siguen.
 *
 * @returns cuántos senders aceptaron el cambio.
 */
export async function replaceTrackOnSenders(
  senders: Iterable<RTCRtpSender | null | undefined>,
  track: MediaStreamTrack | null
): Promise<number> {
  let ok = 0;
  await Promise.all(
    Array.from(senders).map(async (sender) => {
      if (!sender || typeof sender.replaceTrack !== "function") return;
      try {
        await sender.replaceTrack(track);
        ok += 1;
      } catch {
        /* ese par se está cerrando: no arrastres al resto de la malla */
      }
    })
  );
  return ok;
}

/**
 * ¿El motivo es un fallo de MICRÓFONO (permiso/hardware/contexto) y no de red?
 *
 * Se usa al desmutear con éxito para limpiar SÓLO el error de micro anterior sin
 * pisar un aviso de conexión ("connection"), que habla de otra cosa (un par P2P
 * caído) y sigue siendo cierto.
 */
export function isMicErrorReason(reason: VoiceErrorReason): boolean {
  switch (reason) {
    case "permission":
    case "no-mic":
    case "in-use":
    case "insecure":
    case "unknown":
      return true;
    default:
      return false;
  }
}
