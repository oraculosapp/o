# Guía para generar los 18 avatares con Tripo3D

> Para el humano que va a producir los modelos. Objetivo: 18 GLB (9 arquetipos ×
> masculino/femenino) que caen directos en el sistema de avatares ya listo.
> Pruébalos en **`/dev/avatar`** en cuanto los tengas.

## 0. Resumen en 6 pasos

1. Abre [Tripo3D](https://www.tripo3d.ai) → **Image to 3D**.
2. Sube la lámina **frontal** del arquetipo (ver tabla §2).
3. Ajustes: **Humanoid**, activa **auto-rig + animación**, **quad** si está disponible (§3).
4. Presupuesto: **≤ 25 000 triángulos**, textura **1024**, exporta **GLB con rig**.
5. Renombra con la convención (§4) y colócalo en **`apps/web/public/assets/avatars/`**.
6. Abre `/dev/avatar`, escribe el nombre (sin `.glb`) y pulsa **Cargar**.

## 1. Las láminas de origen

Están en `D:\Oraculos\o\assets\avatares\` (una imagen por arquetipo, con 4 vistas).
**Usa la vista FRONTAL** (Tripo3D funciona mejor con una sola vista limpia,
personaje de pie en T o A-pose, fondo plano). Si la lámina trae varias vistas en
una imagen, **recórtala** y sube solo el cuerpo entero frontal.

## 2. Qué imagen usar por arquetipo

| # | Arquetipo | Lámina origen | Nombres de archivo a exportar |
|---|-----------|---------------|-------------------------------|
| 1 | Hacker | `1_hacker.png` | `hacker-m.glb`, `hacker-f.glb` |
| 2 | Godines (oficinista) | `3_godin.png` | `godines-m.glb`, `godines-f.glb` |
| 3 | Artista | `4_artista.png` | `artista-m.glb`, `artista-f.glb` |
| 4 | Licenciado | `2_licenciado.png` | `licenciado-m.glb`, `licenciado-f.glb` |
| 5 | Vampiro | `6_Vampiro.png` | `vampiro-m.glb`, `vampiro-f.glb` |
| 6 | Astrónomo | `5_Astronomo.png` | `astronomo-m.glb`, `astronomo-f.glb` |
| 7 | Chamán / Curandero | `7_Chaman-Curandero.png` | `chaman-m.glb`, `chaman-f.glb` |
| 8 | Bodybuilder | `8_Bodybuilder.png` | `bodybuilder-m.glb`, `bodybuilder-f.glb` |
| 9 | Dedo Verde | `9_dedo-verde.png` | `dedo-verde-m.glb`, `dedo-verde-f.glb` |

> La lámina `0_Personages.png` es la portada/estilo general, no un arquetipo.
> Cada arquetipo se genera **dos veces** (M y F) — usa el prompt de texto o la
> variante de la lámina para diferenciar el género.

## 3. Ajustes recomendados en Tripo3D

- **Modo**: Image to 3D (no Text to 3D).
- **Tipo**: **Humanoid / Character** (activa el auto-rigging humanoide).
- **Auto-rig + animación**: **ACTÍVALO**. El sistema mapea clips por nombre
  difuso (`idle`, `walk`, `run`, `jump`) sin importar el prefijo (`Armature|Walk`,
  `mixamo.com`, `Run_01`… todos valen). Con que traiga **idle + walk** ya se ve
  vivo; el resto degrada con gracia (run = walk acelerado, jump = fallback).
- **Topología**: **Quad** si la ofrece tu plan (deforma mejor al animar); si no,
  triángulos está bien.
- **Estilo**: personaje chibi/estilizado, no realista (encaja con el cel-shading).

## 4. Presupuesto y formato (presupuestos duros del PLAN-MAESTRO §8)

| Parámetro | Valor |
|-----------|-------|
| Triángulos | **≤ 25 000** |
| Textura | **1024×1024** (no 2048) |
| Formato | **GLB** (binario, una sola pieza) |
| Rig | Incluido (skinned) |
| Draco | Opcional (ver §6) |

El motor **convierte los materiales a toon 3 bandas** automáticamente al cargar,
conservando tu textura. No hace falta que exportes con estilo toon.

## 5. Convención de nombres (obligatoria)

`<arquetipo>-<m|f>.glb`, todo en minúsculas, guion medio. Ejemplos:
`hacker-m.glb`, `godines-f.glb`, `dedo-verde-m.glb`, `chaman-f.glb`.
El nombre que escribes en `/dev/avatar` es **sin** `.glb` (p.ej. `hacker-m`).

Colócalos en: **`apps/web/public/assets/avatars/`** (créala si no existe).

## 6. DRACO (compresión de geometría)

El cargador espera el decoder DRACO en **`apps/web/public/draco/`**.

- Si exportas el GLB **sin** compresión Draco (lo normal en Tripo3D), no necesitas
  nada: cargará directo.
- Si comprimes con Draco (para bajar peso), copia los archivos del decoder
  (`draco_decoder.js`, `draco_decoder.wasm`, `draco_wasm_wrapper.js`) desde
  `node_modules/three/examples/jsm/libs/draco/` a `apps/web/public/draco/`.

## 7. Personalización de color (la capa "híbrida")

Cada avatar se puede **retintar por zonas** (`primary` = ropa principal,
`secondary` = ropa secundaria, `hair` = pelo) sin regenerar el modelo. Para que
funcione bien:

- **Ideal**: exporta con **materiales separados** por zona y nómbralos con
  pistas — que el material de pelo incluya `hair`/`pelo`, los acentos incluyan
  `accent`/`trim`/`secondary`, la piel incluya `skin`/`piel`/`face` (esa no se
  tinta). Así el retinte es preciso, por submesh.
- **Si sale con un solo material** (todo horneado en una textura): también
  funciona, con una máscara por rango de color (best-effort). Es menos preciso;
  el equipo afinará las bandas por arquetipo.

Prueba las 3 paletas de ejemplo con los swatches de `/dev/avatar`.

## 8. Cómo probarlos

1. `pnpm --filter @phygitalia/web dev`
2. Abre `http://localhost:3000/dev/avatar`
3. Escribe el nombre (p.ej. `hacker-m`) en el campo GLB y pulsa **Cargar**.
   - Si carga: reemplaza al maniquí. Prueba Idle/Walk/Run/Jump y los tintes.
   - Si falla: toast de error y sigue el maniquí de prueba (revisa nombre/ruta).

## 9. Si Tripo3D no rigea bien (plan B: Mixamo)

Si el auto-rig sale roto (deformaciones feas, huesos mal puestos):

1. Exporta el modelo **sin rig** (solo malla + textura), en T-pose.
2. Indícalo al equipo: hay que pasarlo por **[Mixamo](https://www.mixamo.com)**
   (auto-rig gratuito de Adobe) → descargar con animaciones **idle/walk/run/jump**
   → volver a exportar GLB.
3. Mixamo nombra los huesos `mixamo:Hips`, `mixamo:RightHand`, etc. — el sistema
   ya reconoce esos nombres (manos → props, spine → espalda) y los clips por
   nombre difuso, así que no hay que tocar código.

## 10. Notas de producción (del informe de arte §3)

- Base chibi común: cabeza ~40 % de la altura, manos tipo mitón.
- Reconocibilidad = **70 % silueta + prop icónico + acento de color**.
- Detalles finos (código glow del hacker, manchas del artista, estrellas del
  astrónomo, bordados del chamán) van por **textura/emisivo**, no por polígonos.
- Props icónicos (regadera, catalejo, cayado, maletín) pueden ser assets aparte:
  el sistema los engancha a `handR`/`handL`/`back`. Si vienen dentro del modelo,
  también vale.
- Más simples de generar: **Godines, Bodybuilder**. Más caros: **Chamán,
  Artista, Dedo Verde**.
