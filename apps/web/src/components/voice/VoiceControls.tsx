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
   * Motivo VISIBLE del estado deshabilitado (`enabled=false`). Por defecto es
   * transitorio ("Preparando tu voz…"); el padre puede pasar algo ACCIONABLE si
   * sabe que la sesión falló de plano (p. ej. la causa amable: incógnito/captcha/red).
   */
  disabledReason?: string;
  /**
   * Si se pasa, muestra un botón "Reintentar" bajo el motivo deshabilitado: la
   * sesión falló de plano y el viajero puede reintentar sin recargar a mano. Sólo
   * tiene sentido junto con `enabled=false` (estado sin sesión).
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
  // dejaba al usuario sin entender por qué no hay voz) y el MOTIVO se pinta
  // debajo y se anuncia (aria-describedby + role=status). Sin leyendas confusas:
  // la etiqueta es siempre la acción real.
  if (!enabled) {
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
        <p id={statusId} className={styles.status} role="status" aria-live="polite">
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

      {/* Estado para lectores de pantalla (y visible el hint de error). El mensaje de
          error refleja la CAUSA real; un par P2P fallido estando dentro es un aviso
          suave (no rojo). */}
      <p
        id={statusId}
        className={`${styles.status} ${hardError ? styles.statusError : ""}`}
        role="status"
        aria-live="polite"
      >
        {errorMsg ??
          (joined
            ? muted
              ? "En la voz · micrófono silenciado"
              : "En la voz · micrófono activo"
            : connecting
              ? "Conectando a la voz…"
              : "Fuera del canal de voz")}
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
