# Chat de voz por Biósfera (WebRTC malla P2P + Supabase)

El chat de voz de Phygitalia es **peer-to-peer**: no hay proveedor externo ni
servidor de medios. Cada Biósfera tiene un canal de voz al que los viajeros se
unen desde el chat; el audio viaja directo de navegador a navegador por WebRTC.

> **No requiere credenciales nuevas.** La voz reutiliza el mismo Supabase del
> chat (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`) como canal
> de señalización, y el STUN público de Google para atravesar NAT. No hay claves
> de voz, ni endpoint de token, ni variables de entorno propias que configurar.

---

## Arquitectura

**Malla completa (full mesh).** Cada participante mantiene una
`RTCPeerConnection` nativa con **cada** otro participante. Con _N_ viajeros hay
_N·(N-1)/2_ conexiones. Esto es simple y sin coste de servidor, pero **escala a
pocos** participantes por canal (típicamente ~4-6): el ancho de banda de subida
crece linealmente con el número de pares. Para grupos grandes haría falta un SFU
(fuera del alcance de la v1).

**Señalización sobre Supabase Realtime.** Un único canal
`voz:<biosphereId>` combina:

- **broadcast `signal`** — _offers_, _answers_ y candidatos _ICE_, dirigidos
  (cada mensaje lleva `from`/`to`; el receptor descarta lo que no va para él).
- **presence** — quién está en la voz (roster + contador) y su nombre visible.

**Regla anti-glare** ("quien llega ofrece"): al entrar en el canal, ofrezco
(`offer`) a los pares que **ya** figuran en la presencia; a los que entran
**después** no les ofrezco — ellos, como recién llegados, me ofrecerán a mí y yo
sólo contesto (`answer`). Así, por cada pareja, exactamente un extremo inicia la
negociación y nunca colisionan dos offers.

**ICE / NAT.** Servidores STUN públicos de Google:
`stun:stun.l.google.com:19302` y `stun:stun1.l.google.com:19302`.

> ⚠️ **Sin TURN (limitación conocida v1).** STUN basta para la mayoría de redes
> domésticas, pero en redes muy restrictivas (NAT simétrica, CGNAT de móvil,
> cortafuegos corporativos) dos pares pueden no llegar a conectarse y **no
> oírse**. Añadir un servidor TURN de reenvío resolvería estos casos; queda para
> una iteración futura.

**Audio.** Al unirse se pide `getUserMedia({ audio })` y se entra **MUTEADO**
(las pistas se emiten deshabilitadas; el usuario activa el micro con el botón).
Cada pista se añade (`addTrack`) a todas las peer connections; las pistas
remotas se reproducen en elementos `<audio>` ocultos del DOM.

**Hablando (active speakers).** Un `AnalyserNode` mide el nivel (RMS) del micro
propio y de cada remoto; por encima de un umbral, el participante se marca como
"hablando" (con una breve histéresis para que el indicador no parpadee).

**Limpieza.** Al salir o desmontar se cierran **todas** las peer connections, se
para el micro, se cierra el `AudioContext` y se abandona el canal de presencia.

---

## Gating (sesión)

El canal sólo se abre si hay **sesión** (`enabled`). Anónimo sin sesión no
dispara conexiones. La identidad del participante es la misma que usa el chat
(el `sessionId` de Supabase — anónimo o registrado). Sin sesión, el control de
voz se muestra deshabilitado con _"Voz: inicia sesión"_.

Requiere que **Anonymous sign-ins** esté habilitado en Supabase
(Authentication → Providers → Anonymous), igual que el chat.

---

## Cómo encaja en el código

- **Señalización:** `apps/web/src/lib/voice/signaling.ts` — helper del canal
  `voz:<biosphereId>` (broadcast de offers/answers/ICE + presence). Incluye las
  funciones puras (nombre de canal, diffing de presencia, regla anti-glare,
  constructores de mensaje) que se testean sin DOM ni red.
- **Malla WebRTC:** hook `apps/web/src/lib/voice/useVoiceRoom.ts` — crea una
  `RTCPeerConnection` por par, gestiona offer/answer/ICE, mute, medición de
  "hablando" y limpieza. Reutiliza el cliente Supabase de `lib/supabase.ts`.
- **UI:** `apps/web/src/components/voice/VoiceControls.tsx` — botón unirse/salir,
  micrófono (aria-pressed) e indicador de hablantes. El chat lo monta en su
  `voiceSlot`.

No hay endpoint de servidor (`/api/voice/**` fue eliminado con la migración
desde LiveKit): toda la voz vive en el cliente + Supabase.

---

## Probar

1. Arranca `pnpm --filter @phygitalia/web dev` con el Supabase del chat ya
   configurado (las mismas vars `NEXT_PUBLIC_SUPABASE_*`).
2. Abre una Biósfera e inicia sesión (o deja que se cree la sesión anónima). El
   control de voz debe habilitarse; pulsa **Unirse a la voz**. El navegador pide
   permiso de micrófono la primera vez (entras MUTEADO; actívalo con el botón).
3. Abre una **segunda pestaña** (o dispositivo) con otro nombre en la misma
   Biósfera y únete a la voz allí también. Deberíais oíros; quien habla aparece
   con un punto que pulsa. Si no os oís, probablemente estáis tras una NAT que
   requiere TURN (ver limitación arriba).
