/**
 * optimize-splash.mjs — Pipeline de los chibis del Splash de o.oraculos.app.
 *
 * Distinto de optimize-totems.mjs (ese es de los 10 tótems Draco de la biósfera).
 * Aquí preparamos 6 estatuas chibi para el diorama ceremonial de la PORTADA:
 * son pequeñas en pantalla, así que apretamos fuerte.
 *
 * Fuente: D:\Oraculos\o\assets\avatares\glb\  (versiones LIGERAS, SIN "-standard";
 *         traen EXT_meshopt_compression → hay que registrar MeshoptDecoder al leer).
 *
 * Pipeline por modelo:
 *   1. Poda de mapas PBR: solo baseColor (fuera normal / occlusion /
 *      metallicRoughness / emissive). El look es toon plano.
 *   2. dedup + prune + weld.
 *   3. simplify (los chibis son estatuas lejanas: podemos bajar triángulos).
 *   4. normals: generar solo las que falten (MeshToonMaterial las necesita).
 *   5. textura → 512 px, WebP (chibis diminutos en pantalla).
 *   6. EXT_meshopt_compression a la salida: el navegador la decodifica con el
 *      MeshoptDecoder JS de three/examples (sin .wasm que sumar a la red).
 *
 * Objetivo: ≤ 350 KB por modelo. Salida en apps/web/public/assets/splash/.
 *
 * Uso:  node optimize-splash.mjs
 */

import { statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, meshopt, normals, prune, quantize, simplify, textureCompress, weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = 'D:\\Oraculos\\o\\assets\\avatares\\glb';
const OUT_DIR = path.resolve(__dirname, '..', '..', 'apps', 'web', 'public', 'assets', 'splash');

/**
 * 6 chibis de silueta variada para el círculo ceremonial (sin el island, que no
 * es personaje). Solo versiones ligeras SIN "-standard".
 *   mago · chamana · enano chamán · pelo-morado · pintora · hacker
 */
const MODELS = [
  { src: 'mage-character.glb',        out: 'mage.glb' },
  { src: 'chibi-female-shaman.glb',   out: 'shaman.glb' },
  { src: 'dwarf-shaman.glb',          out: 'dwarf.glb' },
  { src: 'purple-haired-chibi.glb',   out: 'purple.glb' },
  { src: 'painter-character.glb',     out: 'painter.glb' },
  // El hacker arrastra un skin (rig): simplificamos un pelín más para bajar de 350.
  { src: '1-hacker-1.glb',            out: 'hacker.glb', ratio: 0.03 },
];

const TEXTURE_SIZE = 512;
const TARGET_KB = 350;

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

/** Vacía los slots PBR salvo baseColor (look toon plano). */
function stripPBRMaps(document) {
  const stripped = new Set();
  for (const material of document.getRoot().listMaterials()) {
    if (material.getNormalTexture()) { material.setNormalTexture(null); stripped.add('normal'); }
    if (material.getOcclusionTexture()) { material.setOcclusionTexture(null); stripped.add('occlusion'); }
    if (material.getMetallicRoughnessTexture()) { material.setMetallicRoughnessTexture(null); stripped.add('metallicRoughness'); }
    if (material.getEmissiveTexture()) { material.setEmissiveTexture(null); stripped.add('emissive'); }
  }
  return [...stripped];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  const manifest = { generado: new Date().toISOString(), textura: `webp ${TEXTURE_SIZE}`, compresion: 'meshopt', modelos: [] };

  for (const model of MODELS) {
    const srcPath = path.join(SRC_DIR, model.src);
    const outPath = path.join(OUT_DIR, model.out);
    if (!existsSync(srcPath)) { console.error(`  ! falta ${srcPath}`); continue; }
    const srcBytes = statSync(srcPath).size;
    const notas = [];

    console.log(`── ${model.src} (${(srcBytes / 1e6).toFixed(2)} MB) → assets/splash/${model.out}`);
    const document = await io.read(srcPath);
    const trisAntes = countTriangles(document);

    const stripped = stripPBRMaps(document);
    if (stripped.length) notas.push(`PBR podado: ${stripped.join(', ')}`);

    await document.transform(
      dedup(),
      prune(),
      weld(),
      // Estatuas lejanas y diminutas: los chibis de Tripo3D vienen a ~980k tris;
      // bajamos a ~4% (≈40k) con error holgado — imperceptible a esa escala.
      simplify({ simplifier: MeshoptSimplifier, ratio: model.ratio ?? 0.04, error: 0.02 }),
      normals({ overwrite: false }), // solo las que falten; el toon las necesita
      weld(), // re-indexar tras simplify: imprescindible para que meshopt reordene/quantice
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEXTURE_SIZE, TEXTURE_SIZE] }),
      prune(),
      // Quantizar antes de meshopt es lo que de verdad encoge (14 MB → ~0.3 MB).
      quantize({ quantizePosition: 12, quantizeNormal: 8, quantizeTexcoord: 12 }),
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );

    const trisDespues = countTriangles(document);
    await io.write(outPath, document);
    const outBytes = statSync(outPath).size;
    const kb = outBytes / 1e3;
    const flag = kb <= TARGET_KB ? 'OK' : `SOBRE (${TARGET_KB} KB)`;
    console.log(
      `   tris ${trisAntes.toLocaleString()} → ${trisDespues.toLocaleString()} | ` +
      `${(srcBytes / 1e6).toFixed(2)} MB → ${kb.toFixed(1)} KB  [${flag}]\n`,
    );

    manifest.modelos.push({ archivo: model.out, fuente: model.src, bytes: outBytes, tris: trisDespues, notas });
  }

  const totalBytes = manifest.modelos.reduce((s, m) => s + m.bytes, 0);
  manifest.totalBytes = totalBytes;
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`TOTAL modelos: ${(totalBytes / 1e6).toFixed(2)} MB — ${manifest.modelos.length} chibis · manifest en assets/splash/manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
