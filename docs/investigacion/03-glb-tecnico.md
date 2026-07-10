# Informe Técnico — GLBs de los Oráculos (D:\Oraculos\GLB)

> Subagente Opus 4.8 (2026-07-10). Inspección con @gltf-transform/cli + experimento real de
> optimización. Contexto: tótems grandes en mundo three.js cel-shading, presupuesto ~15-20 MB
> TOTAL de experiencia, 60 fps móvil.

## 1. Tabla por modelo

| Modelo | Peso | Tris | Vértices | Texturas | Rig/Anim | Extensiones |
|---|---|---|---|---|---|---|
| **Paqo** ⭐ | 3.45 MB | 102,683 | 57,934 | 1× baseColor **4096** JPG | no | ninguna |
| Mavea | **24.06 MB** | 94,037 | 51,912 | 4× **8192** JPG (PBR full) | no | ninguna |
| Nin | 9.39 MB | 94,695 | 52,798 | 4× 4096 JPG (PBR full) | no | ninguna |
| Brangulio | 9.30 MB | 99,468 | 53,359 | 4× 4096 JPG (PBR full) | no | ninguna |
| Chemajo | 6.79 MB | 50,000 | 29,083 | 3× 4096 JPG | no | ninguna |
| Tecnomancio | 5.26 MB | **153,505** | 86,607 | 1× 4096 JPG | no | ninguna |
| Cosmogenes | 4.51 MB | 118,779 | 67,731 | 1× 4096 JPG | no | ninguna |
| Eme-y-Uru | 3.47 MB | 102,572 | 57,229 | 1× 4096 JPG | no | ninguna |
| Personage | 3.41 MB | 99,376 | 56,236 | 1× 4096 JPG | no | ninguna |
| Espinosito | 3.21 MB | 89,207 | 51,602 | 1× 4096 JPG | no | ninguna |

**Total crudo: ~72.8 MB / ~1.0 M triángulos** (≈3.6× el presupuesto de TODA la experiencia).

### Hallazgos estructurales
- Estructura limpia: 1 malla / 1 primitiva / 1 material c/u. Sin rig ni animaciones ni
  extensiones — mallas estáticas ideales para tótems.
- ⚠️ **FALTA el atributo NORMAL en las 10** (solo POSITION + TEXCOORD_0). Sin normales, el
  cel-shading no puede calcular la rampa de luz → **generar normales en el pipeline**.
- **El problema real es la VRAM, no el disco**: cada 4096 = 89 MB VRAM descomprimida; cada
  8192 = 358 MB. Mavea sola ≈ 1.4 GB VRAM — inviable en móvil.
- Índices u32 en Tecnomancio/Cosmogenes (>65k vértices); tras simplify bajan a u16.

## 2. Veredicto por modelo
- **Paqo, Eme-y-Uru, Personage, Espinosito**: casi listos — textura→1024-2048, Draco, normales.
- **Tecnomancio (153k) y Cosmogenes (119k)**: simplify agresivo (target 40-60k tris).
- **Chemajo**: geometría óptima (50k); descartar occlusion/normal, dejar baseColor.
- **Nin y Brangulio**: pesados por PBR innecesario — en cel-shading sobran metalRough/occlusion/
  normal → solo baseColor 1024 → <400 KB.
- **Mavea**: crítico, NO usar sin procesar (8192×4). Post-pipeline: <1 MB.

## 3. Experimento real con Paqo
- **Variante A** `optimize --compress draco --texture-compress webp` (2048):
  **3.61 MB → 434.97 KB (−88.0%)**. Tris 102,683→90,459. VRAM 89→22.4 MB.
- **Variante B** igual + `--texture-size 1024`:
  **3.61 MB → 300.00 KB (−91.7%)**. Textura 79.66 KB. **VRAM 89→5.59 MB (−94%)**.
- Recomendación: 1024 para secundarios; Paqo (héroe) 2048.
- Nota: WebP se descomprime a RGBA en VRAM. Para 10 tótems simultáneos en móvil, **KTX2/Basis
  (ETC1S)** es superior (queda comprimida en GPU, 4-8× menos VRAM). Requiere `toktx` instalado.

## 4. Pipeline recomendado (comandos exactos)

```bash
# Héroe (Paqo): textura 2048
npx @gltf-transform/cli optimize IN.glb OUT.glb \
  --compress draco --texture-compress ktx2 --texture-size 2048 --simplify-error 0.001
npx @gltf-transform/cli normals OUT.glb OUT.glb   # genera NORMAL faltante

# Secundarios: 1024 + simplify agresivo para Tecnomancio/Cosmogenes
npx @gltf-transform/cli optimize IN.glb OUT.glb \
  --compress draco --texture-compress ktx2 --texture-size 1024
npx @gltf-transform/cli simplify OUT.glb OUT.glb --ratio 0.5 --error 0.002
npx @gltf-transform/cli normals OUT.glb OUT.glb

# Modelos PBR (Mavea, Nin, Brangulio, Chemajo): descartar occlusion/metalRough/normal
# (script gltf-transform que vacíe esos slots de textura) y luego optimize como arriba.
```

**Estimación post-pipeline: ~250-500 KB por tótem → ~4-5 MB los 10**, VRAM combinada <100 MB.

### Acciones prioritarias
1. Generar normales (imprescindible para cel-shading).
2. Descartar mapas PBR en Mavea/Nin/Brangulio/Chemajo.
3. KTX2 (no solo WebP) por la VRAM móvil.
4. Simplify de Tecnomancio y Cosmogenes.
5. Paqo como plantilla validada del pipeline (3.61 MB → 300 KB ✓).
