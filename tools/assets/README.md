# Asset Pipeline — Tótems de los Oráculos (S0)

Optimiza los 10 GLB crudos de `D:\Oraculos\GLB\` (solo lectura, nunca se modifican)
y escribe versiones listas para web en `out/`, según `docs/investigacion/03-glb-tecnico.md`.

## Uso

```bash
cd tools/assets
npm install
npm run optimize        # procesa los 10 y regenera out/manifest.json
```

Inspección de una salida:

```bash
npx @gltf-transform/cli inspect out/paqo.glb
```

## Qué hace por modelo

1. **Poda PBR** (Mavea, Nin, Brangulio, Chemajo): elimina normal/occlusion/metallicRoughness — en cel-shading solo importa baseColor.
2. **dedup + prune + weld**.
3. **Simplify**: agresivo (ratio 0.5, error 0.002) en Tecnomancio y Cosmogenes; suave en el resto.
4. **Genera NORMALES** (ningún GLB original las trae; imprescindibles para cel-shading).
5. **Texturas**: resize a 1024 (Paqo héroe: 2048) + compresión. **KTX2 si `toktx` está en PATH**; si no, fallback WebP (queda anotado en el manifest).
6. **Draco** para geometría.

## Salida

- `out/*.glb` — nombres en minúsculas (`paqo.glb`, `mavea.glb`, …).
- `out/manifest.json` — por modelo: archivo, bytes, tris, textura (formato+resolución), notas.

## Nota KTX2

Para VRAM móvil óptima instala [KTX-Software](https://github.com/KhronosGroup/KTX-Software/releases)
(`toktx` en PATH) y vuelve a correr `npm run optimize`: el script detecta toktx y
re-comprime las texturas a KTX2/ETC1S automáticamente.

---

# Pipeline de avatares (arquetipos riggeados)

`optimize-avatars.mjs` procesa los GLB/FBX **riggeados** de los arquetipos
(auto-rig de Tripo3D o Mixamo). A diferencia de los tótems, aquí lo sagrado es el
**rig**: skin (JOINTS/WEIGHTS), esqueleto y clips. Por eso **no** hace weld ni
simplify agresivo (romperían el skinning).

- **Entrada:** `assets/avatares/glb/rigged/` (solo lectura) — `.glb` o `.fbx`.
- **Salida:** `apps/web/public/assets/avatars/` — convención `<arquetipo>-<m|f>.glb`.
- **Nombra los archivos de entrada con la convención** (`hacker-m.glb`,
  `dedo-verde-f.glb`, …): el pipeline conserva el basename en minúsculas.

Por avatar: (opcional) FBX→GLB con Blender headless → poda PBR a baseColor
(conserva emisivo) → dedup + resample (compacta keyframes) + prune → texturas
WebP 1024 → **quantize + EXT_meshopt_compression** (limpio con skin/animación; el
runtime lo decodifica: `AvatarRig.load` registra `MeshoptDecoder`) → valida
(skin presente, JOINTS_0 intactos, nº de clips preservado, peso ≤ 700 KB).

## El comando (cuando lleguen los riggeados)

```bash
cd tools/assets
npm install                        # una vez (gltf-transform, meshoptimizer, sharp…)
npm run optimize:avatars           # rigged/ → public/assets/avatars/  (+ avatars-manifest.json)
```

- En seco (sin entradas) imprime un mensaje claro y no falla.
- Con `.fbx` en `rigged/` usa Blender automáticamente
  (`C:/Program Files/Blender Foundation/Blender 4.2/blender.exe`, autodetectado).
- Simplify conservador opt-in (preserva bordes de skin):
  `node optimize-avatars.mjs --simplify`.

Pruébalos en `/dev/avatar` (desplegable con los 18 nombres) — muestra qué clips
trajo cada GLB y a qué locomoción (idle/walk/run/jump) quedaron mapeados.

## Miniaturas del selector

`gen-avatar-thumbs.mjs` recorta la vista frontal de cada lámina a un cuadrado WebP
~200px para la cuadrícula del selector de arquetipo:

```bash
npm run thumbs:avatars             # assets/avatares/*.png → public/assets/avatars/thumbs/<arq>.webp
```
