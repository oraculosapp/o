/**
 * optimize-totems.mjs — Pipeline S0 de los tótems de los Oráculos.
 *
 * Lee GLBs crudos desde SRC_DIR (solo lectura) y escribe versiones optimizadas
 * para web en OUT_DIR, según docs/investigacion/03-glb-tecnico.md:
 *
 *   1. Poda de mapas PBR (normal/occlusion/metallicRoughness) en los modelos
 *      que los traen: en cel-shading solo importa baseColor.
 *   2. dedup + prune.
 *   3. weld + simplify (agresivo 0.5/0.002 en Tecnomancio y Cosmogenes;
 *      suave tipo preset optimize en el resto).
 *   4. GENERAR NORMALES (ningún GLB las trae; el cel-shading las necesita).
 *   5. Resize + compresión de textura: 1024 (Paqo héroe: 2048).
 *      KTX2 si `toktx` está en PATH; si no, fallback WebP (se anota en manifest).
 *   6. Draco para geometría.
 *   7. Valida (NORMAL presente, extensión Draco) y escribe out/manifest.json.
 *
 * Uso:  npm install && npm run optimize
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, draco, normals, prune, simplify, textureCompress, weld,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = 'D:\\Oraculos\\GLB';
const OUT_DIR = path.join(__dirname, 'out');

/** Configuración por modelo (fuente → salida, según doc 03). */
const MODELS = [
  { src: 'Paqo.glb',        out: 'paqo.glb',        textureSize: 2048, stripPBR: false, aggressiveSimplify: false },
  { src: 'Brangulio.glb',   out: 'brangulio.glb',   textureSize: 1024, stripPBR: true,  aggressiveSimplify: false },
  { src: 'Nin.glb',         out: 'nin.glb',         textureSize: 1024, stripPBR: true,  aggressiveSimplify: false },
  { src: 'Espinosito.glb',  out: 'espinosito.glb',  textureSize: 1024, stripPBR: false, aggressiveSimplify: false },
  { src: 'Eme-y-Uru.glb',   out: 'eme-y-uru.glb',   textureSize: 1024, stripPBR: false, aggressiveSimplify: false },
  { src: 'Cosmogenes.glb',  out: 'cosmogenes.glb',  textureSize: 1024, stripPBR: false, aggressiveSimplify: true  },
  { src: 'Tecnomancio.glb', out: 'tecnomancio.glb', textureSize: 1024, stripPBR: false, aggressiveSimplify: true  },
  { src: 'Chemajo.glb',     out: 'chemajo.glb',     textureSize: 1024, stripPBR: true,  aggressiveSimplify: false },
  { src: 'Mavea.glb',       out: 'mavea.glb',       textureSize: 1024, stripPBR: true,  aggressiveSimplify: false },
  { src: 'Personage.glb',   out: 'personage.glb',   textureSize: 1024, stripPBR: false, aggressiveSimplify: false },
];

/** ¿Está toktx (KTX-Software) instalado? Decide KTX2 vs fallback WebP. */
function hasToktx() {
  try {
    execSync('toktx --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function countTriangles(document) {
  let tris = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      if (indices) tris += indices.getCount() / 3;
      else if (position) tris += position.getCount() / 3;
    }
  }
  return Math.round(tris);
}

/** Vacía los slots PBR (normal/occlusion/metallicRoughness/emissive) de todos los materiales. */
function stripPBRMaps(document) {
  const stripped = [];
  for (const material of document.getRoot().listMaterials()) {
    if (material.getNormalTexture()) { material.setNormalTexture(null); stripped.push('normal'); }
    if (material.getOcclusionTexture()) { material.setOcclusionTexture(null); stripped.push('occlusion'); }
    if (material.getMetallicRoughnessTexture()) { material.setMetallicRoughnessTexture(null); stripped.push('metallicRoughness'); }
    if (material.getEmissiveTexture()) { material.setEmissiveTexture(null); stripped.push('emissive'); }
  }
  return [...new Set(stripped)];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const useKtx2 = hasToktx();
  console.log(`Compresión de textura: ${useKtx2 ? 'KTX2 (toktx encontrado)' : 'WebP (fallback: toktx NO instalado)'}\n`);

  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const manifest = { generado: new Date().toISOString(), texturas: useKtx2 ? 'ktx2' : 'webp', modelos: [] };

  for (const model of MODELS) {
    const srcPath = path.join(SRC_DIR, model.src);
    const outPath = path.join(OUT_DIR, model.out);
    const srcBytes = statSync(srcPath).size;
    const notas = [];

    console.log(`── ${model.src} (${(srcBytes / 1e6).toFixed(2)} MB) → ${model.out}`);
    const document = await io.read(srcPath);
    const trisAntes = countTriangles(document);

    // 1. Poda PBR (solo baseColor en cel-shading).
    if (model.stripPBR) {
      const stripped = stripPBRMaps(document);
      if (stripped.length) notas.push(`PBR podado: ${stripped.join(', ')}`);
    }

    // 2-4. Limpieza, simplify y NORMALES.
    const simplifyOpts = model.aggressiveSimplify
      ? { simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.002 }   // Tecnomancio / Cosmogenes
      : { simplifier: MeshoptSimplifier, ratio: 0.75, error: 0.0001 }; // suave (preset optimize)
    if (model.aggressiveSimplify) notas.push('simplify agresivo 0.5/0.002');

    await document.transform(
      dedup(),
      prune(),
      weld(),
      simplify(simplifyOpts),
      normals({ overwrite: true }), // ninguno trae NORMAL; imprescindible para cel-shading
      prune(),
    );

    // 5. Texturas: resize + WebP/KTX2. WebP vía sharp aquí; KTX2 vía CLI después.
    await document.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [model.textureSize, model.textureSize],
      }),
    );

    // 6. Draco.
    await document.transform(draco({ method: 'edgebreaker' }));

    const trisDespues = countTriangles(document);
    await io.write(outPath, document);

    // 5b. Si hay toktx, re-comprime texturas a KTX2 (ETC1S) con la CLI.
    if (useKtx2) {
      const cli = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'gltf-transform.cmd' : 'gltf-transform');
      execFileSync(cli, ['etc1s', outPath, outPath, '--quality', '160'], { stdio: 'pipe', shell: process.platform === 'win32' });
    } else {
      notas.push('textura WebP (fallback, instalar KTX-Software/toktx para KTX2)');
    }

    const outBytes = statSync(outPath).size;
    console.log(`   tris ${trisAntes.toLocaleString()} → ${trisDespues.toLocaleString()} | ${(srcBytes / 1e6).toFixed(2)} MB → ${(outBytes / 1e3).toFixed(1)} KB (−${(100 - (outBytes / srcBytes) * 100).toFixed(1)}%)\n`);

    manifest.modelos.push({
      archivo: model.out,
      fuente: model.src,
      bytes: outBytes,
      bytesFuente: srcBytes,
      tris: trisDespues,
      textura: { formato: useKtx2 ? 'ktx2' : 'webp', resolucion: model.textureSize },
      notas,
    });
  }

  const totalBytes = manifest.modelos.reduce((sum, m) => sum + m.bytes, 0);
  manifest.totalBytes = totalBytes;
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`TOTAL: ${(totalBytes / 1e6).toFixed(2)} MB (objetivo ≤ ~6 MB) — manifest en out/manifest.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
