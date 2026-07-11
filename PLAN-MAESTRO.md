# PLAN MAESTRO — Phygitalia · o.Oraculos.app

> v1.0 · 2026-07-10 · Proyecto: **Oráculos Telúrico-Sintéticos**
> Créditos: **Julio Sahagún Sánchez, Tessa Fansa Vega, GrimorIA y Claude.**
>
> Documentos hermanos: [docs/investigacion/](docs/investigacion/) (lore, marca, GLBs, arte) y
> la investigación de Messenger en `D:\Oraculos\app\investigación\`.

---

## 1. Visión

**Phygitalia** es el mundo virtual de los Oráculos Telúrico-Sintéticos: una constelación de
**Biósferas** (mini-planetas 3D), una por Oráculo, comunicadas por **portales**. Los usuarios
caminan, se encuentran, juegan y **consultan a los Oráculos** — chatbots con cuerpo de barro y
voz digital. Extiende la exposición física de Casa Palacio (QR → chat) a un espacio inmersivo
multijugador, con el flujo suave y delicioso de messenger.abeto.co como listón de calidad.

- **Portal primordial**: Oraculos.app (web, chatbots 2D).
- **La experiencia 3D**: https://o.Oraculos.app (este proyecto, en `D:\Oraculos\o`).
- **Norte de producto**: fricción cero (URL → jugando), belleza contemplativa cel-shading
  low-poly, presencia humana cálida, y Paqo como anfitrión que te enruta al Oráculo que necesitas.
- **AI-agent-first**: el contenido (biósferas, oráculos, quests, UI) se define en **datos
  declarativos** que agentes pueden leer/escribir — el camino hacia Generative UI futura.

## 2. Decisiones cerradas (2026-07-10)

| Tema | Decisión |
|---|---|
| Avatares | **Híbrido**: 18 arquetipos Tripo3D (9 × M/F) + capa de personalización (tinte de paleta / prop) |
| Topología | ~~Mini-planeta esférico~~ → **ISLAS FLOTANTES** (pivote 2026-07-11 tras jugar S2.6: la esfera generaba fricción constante — claro-jaula, hundimientos, pasto radial). Modelo híbrido: terreno heightmap con borde de acantilado + panza rocosa, mapas GLB de autor Y/O procedurales, aderezo procedural por preset. Gravedad normal, motor más simple, compatible con mapas hechos a mano (ej. floating-jungle-island.glb) |
| Alcance beta | **Núcleo pulido**: Biósfera Paqo completa (ver §6). Voz, DMs, push y perfiles completos → fase 2 |
| Voz | **LiveKit Cloud** (fase 2) |
| Stack casa | **Vercel + Supabase + Resend + Turnstile** |
| IA | **GPT 5.4** para los Oráculos |
| UI | **Next.js** + tokens de marca del sistema Exposicion |
| Estilo | **Cel-shading low-poly** contemplativo/mesmerizing, outline tinta, oro emisivo Phygitalia |
| Beta objetivo | Lanzamiento mundial de la expo (semanas) — 6 Oráculos prioritarios: Paqo, Brangulio, Nin, Espinosito, Eme-y-Uru, Cosmógenes |

## 3. Arquitectura

```
D:\Oraculos\o  (monorepo pnpm + turbo)
├─ apps/web            → Next.js 15 (App Router) · o.Oraculos.app · Vercel
│   ├─ /               → landing SSR (SEO) + botón ENTRAR (fricción cero)
│   ├─ /b/[biosfera]   → la experiencia 3D (client-only, canvas)
│   ├─ /usuario        → perfil propio · /u/[handle] → perfil público
│   ├─ /api/oracle     → GPT 5.4 streaming (personalidades + memoria)
│   └─ legal: /terminos /privacidad /cookies
├─ packages/engine     → three.js: planeta esférico, controller, cel-shading, cámara, input
├─ packages/biosphere  → generador procedural (presets JSON → mundo)
├─ packages/content    → presets de biósferas, fichas de Oráculos, system prompts, textos
├─ packages/ui         → design system (tokens marca, componentes React, iconos)
├─ tools/assets        → pipeline gltf-transform (draco+ktx2+normals) para tótems y avatares
└─ supabase/           → migrations, RLS, edge functions
```

### Tiempo real (receta de la casa, sin servidor propio)
**Supabase Realtime** por Biósfera-instancia (~40 concurrentes; sharding de instancias si crece):
- **Presence**: roster de quién está (avatar, handle/anon).
- **Broadcast**: posiciones+animación a 10 Hz (interpolación en cliente), emotes, y estado de
  las **9 pelotas** (autoridad = último que tocó; física local reconciliada).
- **Postgres + Realtime**: chat público persistente del canal de la Biósfera.

### Oráculos IA (GPT 5.4)
- Route handler con streaming; **system prompt por Oráculo** desde la guía de tono
  ([01-lore-phygitalia.md §4](docs/investigacion/01-lore-phygitalia.md)).
- **Canal público**: el Oráculo responde cuando se le menciona (`@Paqo ...` o su nombre) — la
  respuesta se publica en el chat del canal.
- **Canal privado**: conversación 1:1 con **memoria** (tabla `oracle_conversations` +
  `oracle_messages`; resumen rodante por usuario) — **solo usuarios registrados** → ES el gancho
  de registro. Anónimos pueden charlar en privado sin memoria (se les invita a registrarse para
  que el Oráculo "los recuerde").
- Paqo además **enruta**: detecta el tema y sugiere el Oráculo/Biósfera adecuado (su rol de lore).
- Guardarraíles: rate-limit por sesión/IP, Turnstile invisible para anónimos, moderación básica,
  presupuesto de tokens por día.

### Cuentas y datos (Supabase)
- Auth: anónimo por defecto (localStorage id) → upgrade a cuenta (email magic-link vía Resend,
  Turnstile en registro). RLS en todo.
- `profiles`: handle, bio, web, redes, avatar (arquetipo+tinte), **fecha de nacimiento y
  ubicación con flag público/privado cada una**.
- `progress`: biósferas desbloadas (Paqo desbloquea la siguiente al encontrarlo).
- Fase 2: `friendships`, `direct_messages`, `notifications`, push subscriptions.

## 4. Los sistemas del motor (packages/engine + biosphere)

1. **Planeta**: cube-sphere con ruido GPU por preset (amplitude/frequency/octaves, ridges,
   `centralClearing` plano para el punto de encuentro). Hitmesh low-poly + three-mesh-bvh.
   LOD con skirts (patrón ProceduralTerrains).
2. **Controller esférico**: gravedad radial, WASD/flechas + arrastre de cámara + **tap-to-move**
   (raycast al terreno y steering; sin navmesh en beta) + joystick táctil. Gate: game feel.
3. **Cel-shading**: MeshToonMaterial 2-3 bandas half-lambert + outline (inverted hull / Sobel)
   `#0E1512` + paleta 5-6 colores por preset + emisivos dorados `#e3b063` con bloom selectivo.
4. **Atmósfera**: fog exp2 de color + capa de niebla baja rodante + cielo gradiente 2 colores +
   partículas instanciadas (mist/spores/fireflies/glitch/stardust/sandDrift según preset).
5. **Agua estilizada**: stream + cascadas + espuma por máscara (preset `water`).
6. **Vegetación instanciada**: grass cards con viento, árboles low-poly con variantes, specials
   por Biósfera (bromelias, hongos glow, cables, puestos de mercado).
7. **Tótems**: GLBs optimizados (pipeline validado: Paqo 3.61 MB → 300 KB) a escala ~8× avatar,
   glifo-runa emisivo en el suelo del claro.
8. **Avatares**: Tripo3D image-to-3D desde la lámina de arquetipos → auto-rig → set de clips
   compartidos (idle/walk/run/wave/sit) → draco+ktx2 → **tinte de paleta por shader** (la capa
   "híbrida" de personalización) + prop icónico intercambiable.
9. **Audio**: ambiente por zona con crossfade + música contemplativa + blips de voz por Oráculo
   + foley UI (todo .ogg, variante móvil). (Producción de audio: pendiente definir con Julio.)

## 5. UI/UX (apps/web + packages/ui)

- **Tokens de marca** del sistema Exposicion ([02-sistema-de-marca.md](docs/investigacion/02-sistema-de-marca.md)):
  dark cósmico `#080a12`, oro `#e3b063`, Chakra Petch display + body (⚠️ resolver licencia Gotham
  o sustituir), radios 16px, easing de marca, patrón "selbar" para toasts.
- **HUD del juego**: chat dockeable (canal público / canal Oráculo privado), roster de presencia,
  emotes, brújula-runa hacia el Oráculo (¡Paqo ES la brújula!), botón mute, botón instalar PWA.
- **Onboarding sin fricción**: landing → ENTRAR → eliges arquetipo (18) + tinte → nombre efímero
  → caes en Paqo. Registro solo cuando aporta valor (memoria del Oráculo, perfil, progreso
  multi-dispositivo).
- **Mensajes-pista**: al deambular, Paqo te "llama" con toasts diegéticos (proximidad/tiempo)
  guiándote hacia él.
- **Notificaciones**: campanita in-app (beta); hover/click marca leída; push web (fase 2).
- **Perfil** `/usuario`: handle, bio, web, redes, avatar, privacidad granular (nacimiento,
  ubicación), progreso de Biósferas (runas desbloqueadas — cada Biósfera con su runa).
- **Legal homologado**: cookies (solo esenciales por defecto), términos, privacidad — mismo
  layout de marca.
- **PWA**: manifest + service worker + botón de instalación desktop/móvil.
- **Magno ejercicio de calidad**: pasadas formales de `/design`, `/design-critique` y
  `/accessibility-review` (WCAG 2.1 AA) + revisión de seguridad + SEO antes de beta pública.

## 6. Alcance de la BETA (núcleo pulido)

**Entra**: Biósfera Paqo (mini-planeta procedural completo) · 18 avatares + tinte · presencia
multijugador + emotes · chat público con @Paqo respondiendo · chat privado con Paqo (memoria si
registrado) · registro Supabase (magic link) · las **9 pelotas** interactivas sincronizadas ·
mensajes-pista y "encontrar a Paqo" → desbloqueo (teaser de las otras 5 Biósferas con sus runas
y "próximamente") · perfil básico · notificaciones in-app · legal + cookies · PWA instalable ·
SEO de landing · móvil de primera clase.

**Fase 2**: las otras 5 Biósferas prioritarias (Cosmógenes/observatorio, Nin, Brangulio,
Espinosito/mercado, Eme-y-Uru) · voz LiveKit · DMs entre usuarios · amistades · push ·
perfiles ricos · interactivo propio por Biósfera. **Fase 3**: los 5 restantes (Mavea prioritaria
por lore), activaciones híbridas, Generative UI.

## 7. Calendario (5 semanas a beta)

| Semana | Objetivo | Gate de salida |
|---|---|---|
| **S0** (días 1-2) | Scaffolding monorepo, CI Vercel, tokens de marca portados, pipeline de assets corriendo (tótems optimizados) | Deploy "hola planeta" en o.Oraculos.app |
| **S1** | Engine: planeta cube-sphere + controller (teclado/mouse/touch/tap-to-move) + cel-shading + outline + fog | **Caminar se siente delicioso** en desktop y móvil |
| **S2** | Generador de biósferas + **Paqo completa** (terreno, agua, niebla, partículas, vegetación, tótem, cielo) + avatares Tripo3D integrados | El "money shot": screenshot que quieres tuitear |
| **S3** | Multijugador (presencia+emotes+pelotas) + chat público/@Paqo + chat privado con memoria + auth + progreso | 2 personas en 2 dispositivos se ven, juegan y hablan con Paqo |
| **S4** | Polish + audio + design-critique + a11y + seguridad + SEO + legal + PWA + carga <10 s | **Beta pública** en o.Oraculos.app |

## 8. Presupuestos duros (herencia Messenger)

- Carga inicial < 6 MB; total < 20 MB; jugable < 10 s.
- 60 fps en móvil medio (probar Android barato + Safari iOS desde S1).
- Draco + KTX2 obligatorios; texturas máx 1024 (héroes 2048); draw calls < 150.
- Cero pantallas de fricción antes de estar dentro.

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Tripo3D rigs de calidad variable | Validar 1 arquetipo end-to-end en S1; plan B: base mesh chibi único + texturas por arquetipo |
| Supabase Realtime insuficiente para posiciones | Medir en S3 con 20+ clientes sintéticos; plan B: servidor ws mínimo en Fly/Cloud Run (patrón Messenger) |
| Costes/latencia GPT 5.4 en canal público | Cooldown por canal, respuestas cortas, cache de saludos, presupuesto diario |
| Scope creep (11 oráculos, voz, DMs...) | El alcance beta de §6 es contrato; todo lo demás es fase 2 |
| Licencia Gotham web | Verificar o sustituir body font (Chakra Petch es OFL) |
| Safari iOS WebGL | Smoke test semanal desde S1 |
| Moderación de chat público | Filtro básico + reporte + throttle; sin DMs en beta reduce superficie |

## 10. División del trabajo (orquestación con subagentes Opus 4.8)

- **Equipo Engine** — planeta, controller, cel-shading, postFX (S1-S2).
- **Equipo Biósfera** — generador procedural + preset Paqo + partículas/agua/vegetación (S2).
- **Equipo Avatares** — Tripo3D, rig, clips, tinte, pipeline (S1-S2).
- **Equipo Plataforma** — Supabase (schema+RLS+realtime), auth, API Oráculo GPT 5.4 (S3).
- **Equipo UI** — design system, HUD, chat, perfil, legal, PWA, notifs (S2-S4).
- **Equipo Contenido** — system prompts por Oráculo, textos de Paqo, pistas, runas (S2-S3).
- **Equipo QA/Calidad** — design-critique, a11y, seguridad, SEO, rendimiento (S4, continuo).

Fable 5 orquesta: define contratos entre paquetes, revisa gates, integra, no pica piedra.
