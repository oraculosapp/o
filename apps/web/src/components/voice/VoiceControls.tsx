"use client";

/**
 * VoiceControls — control de chat de VOZ de una Biósfera (WebRTC malla P2P +
 * Supabase Realtime). AUTOCONTENIDO: recibe todo por props y gestiona su propio
 * ciclo de vida vía `useVoiceRoom`. Pensado para montarse en el `voiceSlot` del chat.
 *
 * Estados de UI:
 *   · Identidad no lista (`enabled=false`): botón "Unirse a voz" deshabilitado
 *     (transitorio; el nombre aleatorio llega al entrar).
 *   · Fuera del canal: botón de marca "Unirse a voz".
 *   · Dentro: botón de micrófono (mute/unmute, aria-pressed) + indicador de quién
 *     habla (puntos que pulsan) + botón "Salir".
 *
 * Letreros de estado — regla de la casa (Julio): los textos TRANSITORIOS e
 * INFORMATIVOS ("Preparando tu voz…", "Conectando a la voz…", "Fuera del canal",
 * "En la voz · micrófono activo/silenciado") NO se ven: desajustaban la fila de
 * segmentos del chat y no aportaban (el mute ya lo comunica el botón de micro con
 * aria-pressed y el glifo tachado). Siguen ANUNCIÁNDOSE para lectores de pantalla
 * en un elemento visually-hidden (`.srOnly`) con aria-live. VISIBLEMENTE sólo se
 * pintan: los ERRORES de `voiceErrorMessage()` (duros y suaves) y el motivo
 * ACCIONABLE de una sesión fallida (`enabled=false` con `onRetry`, junto al botón
 * "Reintentar"). Cuando no hay nada que mostrar, el hueco visible no reserva
 * espacio (el `.srOnly` va fuera de flujo, no cuenta para el gap del contenedor).
 *
 * Accesible: aria-pressed en el micro, aria-live para el estado, focus-visible
 * dorado (design system), áreas táctiles ≥44px. Respeta prefers-reduced-motion.
 * No requiere credenciales nuevas: la voz va sobre el mismo Supabase del chat.
 */
import { useId } from "react";
import { useVoiceRoom, type VoiceParticipant } from "@/lib/voice/useVoiceRoom";
import { isHardVoiceError, voiceErrorMessage } from "@/lib/voice/errors";
import styles from "./voice-controls.module.css";

export interface VoiceControlsProps {
  /** Id de la Biósfera (canal). Debe ser uno de la lista blanca conocida. */
  biosphereId: string;
  /** Identidad estable del participante (sessionId de Supabase, como el chat). */
  identity: string;
  /** Nombre visible del participante. */
  displayName: string;
  /**
   * Gating: sólo con sesión (enabled) se habilita la voz. Por defecto `true`.
   * Pásalo como `false` para mostrar el estado DESHABILITADO: el botón sigue
   * EXISTIENDO (el usuario siempre lo ve y entiende el estado) pero no conecta.
   * OJO: con `enabled=false` el hook no abre canal ni pide micrófono — se puede
   * montar sin sesión sin efectos secundarios (es lo que hace el chat).
   */
  enabled?: boolean;
  /**
   * Motivo del estado deshabilitado (`enabled=false`). Por defecto es transitorio
   * ("Preparando tu voz…") y sólo se ANUNCIA (no se ve). Se pinta VISIBLEMENTE
   * únicamente cuando es ACCIONABLE, es decir cuando además llega `onRetry` (la
   * sesión falló de plano: incógnito/captcha/red) — ahí acompaña al botón
   * "Reintentar". La distinción transitorio↔fallido la decide el padre (ChatDock).
   */
  disabledReason?: string;
  /**
   * Si se pasa, la sesión falló DE PLANO: el motivo se muestra VISIBLE y debajo
   * aparece un botón "Reintentar" para reconectar sin recargar a mano. Su presencia
   * es también la señal de que `disabledReason` es accionable (no un transitorio).
   * Sólo tiene sentido junto con `enabled=false` (estado sin sesión).
   */
  onRetry?: () => void;
  /** Clase extra opcional para el contenedor (posicionamiento del slot). */
  className?: string;
  /**
   * Clase del BOTÓN "Unirse a voz". El chat la inyecta (su `.segment`) para que la
   * voz se vea IGUAL que los tabs General/Privado (una fila de tres controles con
   * el mismo tamaño, forma y glass). Si falta, usa el estilo propio de marca.
   */
  buttonClassName?: string;
}

export function VoiceControls({
  biosphereId,
  identity,
  displayName,
  enabled = true,
  disabledReason = "Preparando tu voz…",
  onRetry,
  className,
  buttonClassName,
}: VoiceControlsProps) {
  const { joined, join, leave, muted, toggleMute, participants, connectionState, errorReason } =
    useVoiceRoom({
      biosphereId,
      identity,
      displayName,
      enabled,
    });

  const statusId = useId();
  const containerClass = [styles.voice, className].filter(Boolean).join(" ");
  // El botón "Unirse a voz" usa la clase del chat (segmento unificado) si se inyecta.
  const joinClass = buttonClassName ?? styles.join;

  // --- Gating: identidad aún no lista → mismo botón "Unirse a voz", pero
  // deshabilitado. El botón SIEMPRE existe (nunca desaparece en silencio: eso
  // dejaba al usuario sin entender por qué no hay voz) y el MOTIVO se anuncia
  // (aria-describedby + role=status). Sin leyendas confusas: la etiqueta es
  // siempre la acción real.
  //
  // El motivo sólo se VE cuando es accionable (hay `onRetry` → sesión fallida);
  // el transitorio ("Preparando tu voz…") se queda en el elemento .srOnly, que se
  // anuncia pero no desajusta la fila. Con `onRetry`, motivo visible + botón
  // "Reintentar" juntos, tal cual.
  if (!enabled) {
    const reasonActionable = Boolean(onRetry);
    return (
      <div className={containerClass}>
        <button
          type="button"
          className={joinClass}
          disabled
          aria-disabled="true"
          aria-describedby={statusId}
          title={disabledReason}
        >
          <MicGlyph muted />
          <span>Unirse a voz</span>
        </button>
        <p
          id={statusId}
          className={reasonActionable ? styles.status : styles.srOnly}
          role="status"
          aria-live="polite"
        >
          {disabledReason}
        </p>
        {onRetry && (
          <button type="button" className={styles.retryBtn} onClick={onRetry}>
            Reintentar
          </button>
        )}
      </div>
    );
  }

  const connecting = connectionState === "connecting";
  const speaking = participants.filter((p) => p.speaking);
  // Mensaje HONESTO según la causa real (permiso / sin micro / ocupado / HTTPS /
  // conexión P2P). Un par fallido estando ya dentro es un aviso SUAVE, no rojo.
  const errorMsg = voiceErrorMessage(errorReason, joined);
  const hardError = isHardVoiceError(errorReason, joined);
  // Estado INFORMATIVO (no error): sólo para lectores de pantalla. El texto de
  // mute/actividad no se pinta (lo dice el botón de micro); aquí existe para que
  // aria-live lo anuncie en cada transición.
  const informativeStatus = joined
    ? muted
      ? "En la voz · micrófono silenciado"
      : "En la voz · micrófono activo"
    : connecting
      ? "Conectando a la voz…"
      : "Fuera del canal de voz";
  // Se VE sólo si hay error; si no, el mismo nodo aria-live se queda .srOnly (se
  // anuncia sin ocupar layout ni desajustar la fila de segmentos).
  const statusText = errorMsg ?? informativeStatus;

  return (
    <div className={containerClass}>
      {!joined ? (
        <button
          type="button"
          className={joinClass}
          onClick={() => void join()}
          disabled={connecting}
          aria-describedby={statusId}
        >
          <MicGlyph muted />
          <span>{connecting ? "Conectando…" : "Unirse a voz"}</span>
        </button>
      ) : (
        <div className={styles.live}>
          <button
            type="button"
            className={styles.mic}
            onClick={() => toggleMute()}
            aria-pressed={!muted}
            aria-label={muted ? "Activar micrófono" : "Silenciar micrófono"}
            title={muted ? "Activar micrófono" : "Silenciar micrófono"}
          >
            <MicGlyph muted={muted} />
          </button>

          <Speakers speaking={speaking} count={participants.length} />

          <button
            type="button"
            className={styles.leave}
            onClick={() => leave()}
            aria-label="Salir de la voz"
            title="Salir de la voz"
          >
            Salir
          </button>
        </div>
      )}

      {/* Estado en un ÚNICO nodo aria-live: siempre anuncia (a lectores) el estado
          actual, pero sólo se VE cuando es un ERROR. El mensaje de error refleja la
          CAUSA real; un par P2P fallido estando dentro es un aviso suave (no rojo).
          Sin error, el nodo va .srOnly: se anuncia sin ocupar espacio ni desajustar
          la fila de segmentos. */}
      <p
        id={statusId}
        className={
          errorMsg ? `${styles.status} ${hardError ? styles.statusError : ""}` : styles.srOnly
        }
        role="status"
        aria-live="polite"
      >
        {statusText}
      </p>
    </div>
  );
}

/** Indicador de quién habla: puntos que pulsan + nombres (o vacío discreto). */
function Speakers({ speaking, count }: { speaking: VoiceParticipant[]; count: number }) {
  if (speaking.length === 0) {
    return (
      <span className={styles.speakersEmpty} aria-live="polite">
        {count > 1 ? "Nadie habla" : "Esperando a más viajeros…"}
      </span>
    );
  }
  return (
    <ul className={styles.speakers} aria-live="polite" aria-label="Hablando ahora">
      {speaking.slice(0, 5).map((s) => (
        <li key={s.identity} className={styles.speaker}>
          <span className={styles.pulse} aria-hidden />
          <span className={styles.speakerName}>{s.isLocal ? "Tú" : s.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** Glifo de micrófono (trazo currentColor); tachado cuando está muteado. */
function MicGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {muted && (
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}
