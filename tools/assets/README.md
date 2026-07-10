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
