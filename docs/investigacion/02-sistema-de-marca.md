# Informe de Sistema de Marca — Oráculos → o.Oraculos.app

> Destilado por subagente Opus 4.8 (2026-07-10) de `D:\Oraculos\Exposicion\index.html`
> (tokens en líneas 47-69, iconos 737-756), `inventario.md` y `assets\Fuentes\`.
> Sistema **dark-first, cósmico-dorado**.

## 1. Tokens de diseño

### Paleta (hex exactos)

| Token | Valor | Uso |
|---|---|---|
| `--bg-0` | `#080a12` | Fondo base |
| `--bg-1` | `#0d0f1a` | Fondo secundario |
| `--bg-2` | `#141726` | Fondo elevado |
| `--panel` | `rgba(20,23,38,.66)` | Paneles translúcidos (glass) |
| `--panel-solid` | `#12141f` | Panel opaco |
| `--panel-hi` | `rgba(31,35,54,.9)` | Panel hover |
| `--gold` | **`#e3b063`** | **Acento de marca** (interactivo/importante) |
| `--gold-bright` | `#f6dca0` | Dorado claro: activo, brillos |
| `--gold-dim` | `#b0854a` | Dorado apagado: bordes, metadatos |
| `--terra` | `#c98a5e` | Terracota (cerámica) |
| `--sand` | `#d8c3a5` | Arena |
| `--text` | `#ece7dd` | Texto principal (blanco cálido) |
| `--text-dim` | `#9d97a9` | Texto secundario |
| `--text-faint` | `#948fa4` | Terciario/placeholders |
| `--line` | `rgba(227,176,99,.16)` | Bordes |
| `--line-soft` | `rgba(214,195,165,.10)` | Bordes suaves |
| `--glow` | `rgba(227,176,99,.35)` | Resplandor |

**Fondo cósmico**: gradientes radiales terracota `rgba(201,138,94,.16)` + índigo
`rgba(80,96,150,.18)` + dorado `rgba(227,176,99,.08)` sobre lineal `#0a0c16→#0b0d18→#0d0e19→#0a0b13`
+ campo de estrellas canvas + viñeta. `theme-color: #0b0d16`.

### Tipografías
- **Chakra Petch** (.ttf, OFL/Google Fonts) 400-700 — display "runa tecnológica": titulares,
  labels, badges, botones; `letter-spacing .14-.42em`, a menudo uppercase.
- **Gotham** (.otf, 74 archivos) 300/400/500/700 — texto de lectura. ⚠️ **Comercial, sin .woff2**:
  verificar licencia web o sustituir para el body.
- Fallbacks: `'Gotham','Segoe UI',system-ui,sans-serif` / `'Chakra Petch',monospace`.

### Espaciado, radios, sombras, movimiento
- Radios: `16px` tarjetas, `11px` sm, `999px` píldoras, `50%` avatares.
- Sombra: `0 18px 50px -18px rgba(0,0,0,.7)` + glow dorado en hover.
- Easing de marca: `cubic-bezier(.22,.61,.36,1)`; transiciones 160-320 ms; hover `translateY(-3px)`.
- `backdrop-filter: blur(8-16px)`; animación `runaspin` (runa girando 220 s); shimmer dorado de
  carga; `::selection` dorada; scrollbars finas doradas.

## 2. Componentes y patrones existentes
Topbar glass con logo invertido a dorado · buscador píldora con anillo de focus dorado ·
sidebar/árbol con fila activa en gradiente dorado · **3 variantes de botón** (primary gradiente
dorado con texto oscuro / secundario borde / icon 38px) · tarjetas glass con hover elevado ·
section-hero con glyph · badges píldora dorada · **selbar** (píldora glass flotante inferior —
modelo perfecto para toasts/notificaciones del juego) · visor/lightbox full-screen ·
estados `:hover/:active/:focus-visible/.selected/.loading/.empty/[disabled]` ·
**set de iconos SVG propio** (`ICONS`: folder, home, catalog, cosmos, face, book, gift, panel,
type, image, pdf, vector, raster, text, generic, download, zoom, check — trazo 1.6px currentColor)
· responsive 900/720/640/560px con drawer.

## 3. Inventario útil para el juego (base `D:\Oraculos\Exposicion\assets\`)
- **Identidad**: `oraculos-logotipo.png/.pdf/.ai` · `isotipo-a/b` (máscara oracular — icono de
  app, watermark) · `runa.png` (sigilo dorado — portales, spinner, emblema) · favicons ·
  `JSS-logotipo.png` y `Phygitalia.png` (créditos).
- **Retratos** (`retratos/`, ~200 KB c/u): brangulio, cosmogenes, eme-y-uru, espinosito, nin,
  paqo — **avatares de chat y placas de diálogo** (falta Mavea).
- **Catálogo** (`catalogo/`, 7 fichas con medidas) — fichas de personaje/lore.
- **Escenas IA** (`imagenes-IA/`, 12 PNG vertical+horizontal) — fondos de carga por Biósfera,
  texturas de portal, fondos de diálogo. (Cosmógenes horizontal = `Cosmo-horizontal.png`.)
- **Storytelling** (`storytelling/`, 10 láminas + PDF) — onboarding/narrativa.
- **Referencia 3D**: `regalos/Brangulio-10cm.png`, `Nin-10cm.png` (+PSD 57 MB).
- **Fuentes**: `Fuentes/{Chakra_Petch,Gotham}` completas.
- ⚠️ **No existe ningún asset 3D, sprite, textura PBR ni audio** — todo es 2D/print.

## 4. Mapeo marca → juego
- Un solo `tokens.css`/theme compartido web+juego con los hex de arriba. UI siempre dark cósmico.
- Canvas 3D y menús sobre `--bg-0`/nebulosa; **un solo acento dorado** para lo interactivo.
- HUD: paneles `--panel` + blur + borde `--line`, radios 16px.
- Chat/toasts: patrón `selbar` (píldora glass flotante); burbujas propias `--panel-hi` / ajenas
  `--panel`; emisor en Chakra Petch uppercase dorado; cuerpo en Gotham; avatar = retrato.
- Diálogo de Oráculo: caja inferior con escena IA + overlay `rgba(8,10,18,.45)`, retrato circular
  con glow, botón continuar primary.
- **Cel-shading 3D con la paleta**: luz cálida `#f6dca0`, sombras índigo `#141726`, rim-light
  `--glow`, emisivos de runas/portales `#e3b063`, terracota/arena para el material cerámico de
  los tótems → coherencia total con la cerámica real.
- Loader: logo dorado + `runa.png` girando (`runaspin`) sobre nebulosa.

## 5. Huecos a resolver
1. **Licencia web de Gotham** (o sustituir body font; Chakra Petch es libre).
2. Sin modo claro (decidir si se necesita).
3. **Sin assets 3D ni audio** — hay que producirlos (los GLB de tótems ya existen en `D:\Oraculos\GLB`).
4. Iconos de gameplay faltantes: chat, amigos, notificación, ajustes, mute, emotes, mapa, online.
5. Estados semánticos faltantes: error/success/warning, tooltips, modales, badges numéricos,
   skeleton de chat, estados de conexión, avatar por defecto.
6. Mavea sin retrato ni escena IA.
7. Extender paleta semántica (terracota=alerta, un teal=éxito) sin romper la marca.
8. Formalizar escalas `--space-*` / `--font-size-*`.
9. Exportar isotipo/logotipo a SVG.
