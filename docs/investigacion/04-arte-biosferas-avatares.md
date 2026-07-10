# Informe de Dirección de Arte — Biósferas, Avatares y Estilo Phygitalia

> Subagente Opus 4.8 (2026-07-10). Fuentes: 10 ambientes (`D:\Oraculos\IA\ambiente\JPEG\`),
> 9 arquetipos (`D:\Oraculos\o\assets\avatares\`), estilo (`Exposicion\assets\Phygitalia.png`,
> `runa.png`). Objetivo: traducir referencias a parámetros de generación procedural
> (three.js, cel-shading low-poly).

## 1. Fichas visuales por Biósfera

### ⭐ PAQO — valle umbral (detalle doble)
Valle andino-neozelandés de niebla: cañón glaciar verde musgo donde nace un río. Biósfera
"umbral" — abierta, receptora, claro central natural (pradera florida junto al arroyo) rodeado
de anfiteatro de montañas → ahí va el tótem.
- **Paleta**: `#3B4A3F` musgo profundo · `#8FA98C` salvia niebla · `#C9D2CE` bruma · `#5C6B5A`
  oliva roca · `#A8B84E` pradera ácida · `#E8ECEA` cielo lechoso.
- **Terreno**: valle en U glaciar; laderas casi verticales, fondo plano suave. Rocas erráticas
  musgosas dispersas.
- **Vegetación**: pasto alto denso (grass cards con viento), árboles retorcidos con musgo
  colgante (*Old Man's Beard*) en cornisas, flores blancas/naranjas en el claro. Densidad media,
  concentrada en bordes.
- **Agua**: fuerte — arroyo serpenteante + cascadas delgadas por las paredes + laguna glaciar.
  Clara, casi blanca de espuma.
- **Cielo/luz**: mañana nublada, cielo blanco sin sol, luz difusa fría-neutra `#DCE4E2`, sin
  sombras duras.
- **Niebla**: PROTAGONISTA — densa, blanca-verdosa, exponencial fuerte + capas bajas rodando.
- **Partículas**: micro-gotas, esporas/polen tenue, spray de cascadas, luciérnagas al atardecer.
- **Props**: árboles-guardianes, rocas-menhir, cascadas-hilo. **Mood**: brumoso, receptivo, umbral.

### BRANGULIO — bosque de niebla exuberante
`#2E4025 · #6B8E4E · #B23A2E (bromelia) · #C9A96B (niebla dorada) · #8B7355 · #D8B4C4 (orquídea)`.
Suelo de selva nubosa casi plano con montículos. Vegetación MÁXIMA: bromelias rojas, orquídeas,
helechos arbóreos, epífitas. Sin agua (humedad implícita). Dosel cerrado, luz cenital cálida-verde.
Niebla media-densa entre troncos. Esporas y motas de luz. Mood: exuberante, vivo, encerrado.

### NIN — jungla encantada con río
`#1F3D2E · #3AA76D esmeralda · #37D6C4 cian bioluminiscente · #C97B4A hongo coral · #6FE38A neón
vegetal · #0E2A24`. Lecho de río con raíces gigantes. Monstera/filodendros + **hongos
bioluminiscentes**. Río central turquesa translúcido + cascada. God-rays dorados por el dosel.
Niebla ligera dorada. Motas doradas, luciérnagas, esporas glow. Mood: mágico, húmedo, encantado.

### ESPINOSITO — mercado/tianguis
`#C0392B tomate · #E67E22 naranja · #7CB342 hoja · #8E44AD maíz morado · #2980B9 textil ·
#D4A373 canasto`. NO natural: suelo tierra/piedra, mesas de madera, **toldos multicolor** tapando
el cielo, luz cálida difusa. Sin niebla ni agua. Polvo suspendido cálido. Props clave: puestos,
canastos, textiles colgantes, mercancía apilada. Mood: abundante, humano, festivo.

### EME-Y-URU — bosque templado ordenado
`#2C3A24 · #4E7A3E · #7FA86B · #8B9B8E piedra · #5C4B3A · #B8C4B0`. Sendero de piedra/adoquín +
arroyo rocoso. Helechos y musgo, densidad ordenada (jardín zen natural). Luz de día suave verdosa.
Niebla leve al fondo. Props: camino empedrado, vasija de barro, **cantos rodados apilados
(mojones)**. Mood: sereno, ordenado, contemplativo.

### COSMÓGENES — cordillera nocturna
`#0A0E1A · #1B2740 · #C9B79C polvo estelar · #8A6D5A nebulosa · #3A4A6B · #E8E4DA estrellas`.
Picos dolomíticos afilados, **mar de nubes** entre cumbres. Sin vegetación. **El cielo es el
protagonista**: Vía Láctea, constelaciones dibujadas con líneas, luz de luna azul fría. Nubes
bajas rodando. Estrellas titilantes, polvo cósmico, meteoros. Mood: cósmico, sublime, silencioso.

### BABA-TOTIK — bosque de abedules dorado
`#2E3A2A · #5C7348 · #B8A878 · #8FA26B · #6B5A42 · #DCD6B8`. Troncos verticales esbeltos,
**god-rays dorados horizontales** en la niebla del amanecer. Estelas/tótems de piedra antiguos
entre árboles. Motas doradas, polen. Mood: ancestral, luminoso, sagrado.

### CHEMAJO — desierto crepuscular
`#E8C89A arena · #D4A26A duna · #C98B6B roca rosada · #8B6F9C cielo malva · #4A5A7C crepúsculo ·
#F0D9A8`. Dunas + mesetas erosionadas. Sin vegetación ni agua. Degradado azul-malva-durazno con
**luna creciente**, luz rasante dorada. Bruma cálida de arena. Ruinas/arcos semienterrados.
Mood: árido, melancólico, antiguo.

### TECNOMANCIO — caverna tecno-mágica
`#0D1117 · #2AB7FF cian neón · #FF8A3C naranja circuito · #4A5560 · #7DE0FF glow · #1A2733`.
Interior: roca facetada con **vetas de circuito luminoso**, cables serpenteando ("vegetación de
cables"), paneles retro-futuro, holograma, portal al fondo. Luz emisiva cian+naranja. Chispas,
glitch, datos flotantes. Mood: subterráneo, arcano-digital, eléctrico.

### PERSONAGE — bosque onírico de arquetipos
`#1E3A3A · #3AA0B0 cian espectral · #B85AC4 magenta hongo · #6BE0FF · #4E7A5C · #0F2530`.
Bosque encantado nocturno, sendero empedrado, hongos bioluminiscentes multicolor, **máscaras/
tótems tribales y cráneos entre raíces**. Niebla azul mística, luciérnagas. Mood: onírico, mítico,
umbral. *(El más "cel-shaded/ilustrado" — mejor referencia del target visual.)*

## 2. Esquema de parámetros del generador procedural

Cada Biósfera = un preset de este JSON (ejemplo con valores de Paqo):

```jsonc
{
  "id": "paqo",
  "mood": ["brumoso","receptivo","umbral"],
  "palette": { "primary":"#3B4A3F", "secondary":"#8FA98C", "accent":"#A8B84E",
               "ground":"#5C6B5A", "sky":"#E8ECEA" },
  "terrain": {
    "type": "valley",           // plains|valley|dunes|peaks|forestFloor|cave|market|riverbed
    "heightNoise": { "kind":"perlin", "amplitude":42, "frequency":0.012, "octaves":4 },
    "ridges": { "enabled":true, "steepness":0.85 },
    "centralClearing": { "enabled":true, "radius":30, "flatness":0.9 },  // punto de encuentro
    "rockScatter": { "density":0.3, "mossy":true, "lowPolyFacets":7 }
  },
  "vegetation": {
    "grass":   { "density":0.85, "height":1.4, "windSway":0.6 },
    "trees":   { "type":"gnarled", "density":0.35, "mossHang":true, "clusterAtEdges":true },
    "shrubs":  { "type":"fern", "density":0.4 },
    "flowers": { "density":0.15, "colors":["#E8ECEA","#E67E22"] },
    "special": { "type":"none" } // bromeliads|mushroomsGlow|cropStalls|epiphytes|cablesVines
  },
  "water": { "present":true, "bodies":["stream","waterfalls","glacialLake"],
             "color":"#C9D2CE", "flowSpeed":0.4, "foam":0.7, "reflectivity":0.5 },
  "sky": { "preset":"overcastDawn",  // clearNight|overcastDawn|canopyGodrays|duskGradient|caveInterior|tentCanopy
           "gradientTop":"#E8ECEA", "gradientBottom":"#C9D2CE",
           "sunVisible":false, "moon":false, "stars":false, "milkyWay":false,
           "godrays": { "enabled":false } },
  "lighting": { "keyColor":"#DCE4E2", "keyIntensity":0.7, "keyAngle":25,
                "ambientColor":"#B8C4C0", "ambientIntensity":0.6,
                "shadowSoftness":0.9, "celBands":3 },
  "fog": { "type":"exp2", "color":"#D8E0DE", "density":0.045,
           "groundLayer": { "enabled":true, "height":6, "rolling":true } },
  "particles": [
    { "type":"mist",   "density":0.6, "color":"#FFFFFF", "size":0.4 },
    { "type":"spores", "density":0.3, "color":"#C9D2CE" },
    { "type":"spray",  "density":0.2, "anchor":"waterfalls" }
    // dust|fireflies|glitch|dataBits|stardust|sandDrift|pollen
  ],
  "props": [
    { "type":"guardianTree", "count":6, "placement":"edges" },
    { "type":"menhirRock",   "count":4 },
    { "type":"totemMount",   "count":1, "placement":"centralClearing", "scale":8 }
  ],
  "postFx": { "bloom":0.3,
              "outline": { "enabled":true, "thickness":1.5, "color":"#0E1512" },
              "colorGrade":"cool" }
}
```

Ejes de mayor variabilidad entre las 10: `terrain.type`, `sky.preset`, `fog`, `vegetation.special`,
`water.bodies`, `particles[].type`, temperatura de `lighting.keyColor`. Casos especiales:
Cosmógenes (`peaks` + stars/milkyWay), Tecnomancio (`caveInterior` + emisivos + glitch),
Chemajo (`dunes` + `duskGradient` + sandDrift), Espinosito (`market`: props > terreno).

## 3. Avatares — 9 arquetipos (chibi, cel-shading, M/F, 4 vistas)

| # | Arquetipo | Clave de silueta | Prop icónico | Acento | Complejidad |
|---|---|---|---|---|---|
| 1 | Hacker | Hoodie oversize con código glow | Audífonos + gafas AR | Verde neón `#8ACE3B` | Media |
| 2 | Godines | Camisa remangada + corbata | Maletín + gafete + café | Cafés/beige | **Baja** |
| 3 | Artista | Boina + gabardina manchada | Pincel + paleta | Multicolor/beige | Media-alta |
| 4 | Licenciado | Levita con filigrana dorada | Libro + balanza ⚖ | Negro-azul + oro | Media |
| 5 | Vampiro | Capa cuello alto rojo/negro | Broche rojo | Negro + `#8E1B2E` | Media-alta |
| 6 | Astrónomo | Túnica azul noche estrellada | Catalejo (M) / esfera armilar (F) | `#1B2740` + oro | Media |
| 7 | Chamán | Túnica verde rúnica, pelo blanco trenzado | Cayado con dijes | Oliva + plata | **Alta** |
| 8 | Bodybuilder | Musculatura exagerada + arneses | Cinturones/hebillas | Bronce + cuero; pelo rosa (F) | Media |
| 9 | Dedo Verde | Overol + sombrero con plantas vivas | Regadera | Verde-azul + café | Media-alta |

**Notas de producción**: base mesh chibi común (cabeza ~40% de la altura, manos mitón).
Reconocibilidad = 70% silueta + prop icónico + acento de color. Detalles finos (código, manchas,
estrellas, bordados) por **textura/emisivo**, no polígonos. Props como **assets intercambiables**
enganchados a la mano. Más simples: Godines, Bodybuilder. Más caros: Chamán, Artista, Dedo Verde.

## 4. Síntesis de estilo Phygitalia → three.js

**Lo que define a Phygitalia** (runa.png, Phygitalia.png): línea geométrica esotérica tipo
sigilo (flechas, círculos concéntricos, constelaciones, simetría axial); **oro luminoso
`#D4B26A`/`#E8C87A` emisivo sobre azul-carbón `#1A2436`** y tierra-humo ("alquimia digital",
"pergamino cósmico"); grano/niebla, glow suave, atmósfera en todo; composición central radial
con aire negativo alrededor de un símbolo-tótem.

**Traducción técnica**:
1. **Outline**: contorno `#0E1512` (azul-carbón, no negro), inverted-hull o Sobel
   (normales+profundidad), 1-2 px constante — el look "ilustrado" tipo Personage.
2. **Toon ramp**: `MeshToonMaterial` con gradientMap de 2-3 bandas (terreno/follaje 2,
   personajes 3). Half-lambert para que la niebla no ennegrezca.
3. **Paleta acotada**: 5-6 colores por Biósfera; el `accent` reservado a **emisivos con bloom**
   — el oro Phygitalia es el lenguaje de lo mágico/digital.
4. **Runas como decals emisivos** dorados en el claro central, tótems y espaldas de avatares.
5. **Atmósfera**: niebla de color + bloom moderado + grano/viñeta leve. Cielo siempre gradiente
   de 2 colores del preset, nunca skybox fotográfico.
6. **Tótems**: low-poly facetado con vetas/glifos emisivos dorados-cian en `centralClearing` —
   el ancla que literaliza el puente físico↔digital.

**Arranque recomendado**: pipeline toon+outline+fog con el preset Paqo (valle, niebla densa,
cascadas, tótem con glifo dorado) — valida todos los subsistemas del generador antes de escalar.
