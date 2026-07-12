/**
 * optimize-avatars.mjs — Pipeline de los AVATARES riggeados (arquetipos Tripo3D/Mixamo).
 *
 * A diferencia de optimize-totems (props estáticos), aquí lo sagrado es el RIG:
 * skin (JOINTS_0/WEIGHTS_0), esqueleto y clips de animación. Por eso NO se hace
 * weld ni simplify agresivo (romperían el skinning). El presupuesto de triángulos
 * (≤ 25 000) ya lo cumple Tripo3D en origen; aquí sólo comprimimos sin deformar.
 *
 * Por avatar:
 *   1. (si es .fbx) Blender headless FBX → GLB (preserva skin + animaciones).
 *   2. Poda PBR a baseColor: quita normal/occlusion/metallicRoughness (en
 *      cel-shading sólo importa el color; el emisivo se conserva — glow del hacker…).
 *   3. dedup + resample (compacta keyframes SIN alterar el movimiento) + prune.
 *   4. Texturas → WebP 1024.
 *   5. quantize + EXT_meshopt_compression (meshopt): comprime geometría, skin y
 *      animación de forma limpia (quantizeWeight 8 + normalizeWeights). Es la vía
 *      recomendada para modelos skinned/animados y la que el runtime ya decodifica
 *      (AvatarRig.load registra MeshoptDecoder).
 *   6. Valida: skin presente, JOINTS_0 en las prims, nº de clips preservado,
 *      peso ≤ 700 KB (aviso si se pasa). Escribe out en public + manifest.
 *
 * Entrada:  assets/avatares/glb/rigged/   (solo lectura)   — .glb o .fbx
 * Salida:   apps/web/public/assets/avatars/                — convención <arq>-<m|f>.glb
 *
 * Nombra los archivos de entrada con la convención (hacker-m.glb, dedo-verde-f.glb):
 * el pipeline conserva el basename en minúsculas. Ver docs/avatares-tripo3d.md §5.
 *
 * Uso:
 *   cd tools/assets
 *   npm install
 *   node optimize-avatars.mjs            # procesa rigged/ → public/assets/avatars
 *   node optimize-avatars.mjs --simplify # + simplify CONSERVADOR (ratio 0.9) opt-in
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, meshopt, prune, resample, simplify, textureCompress,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(REPO, 'assets', 'avatares', 'glb', 'rigged');
const OUT_DIR = path.join(REPO, 'apps', 'web', 'public', 'assets', 'avatars');

const TEXTURE_SIZE = 1024;
const TARGET_BYTES = 700 * 1024; // 700 KB por avatar (aviso si se pasa)
const DO_SIMPLIFY = process.argv.includes('--simplify');

/** Localiza blender.exe (4.2 / 5.0 / …) para convertir FBX. */
function findBlender() {
  const base = 'C:/Program Files/Blender Foundation';
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    const exe = path.join(base, dir, 'blender.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** Convierte un .fbx a .glb con Blender headless (preserva skin + animaciones). */
function fbxToGlb(blender, srcFbx, dstGlb) {
  const script = `
import bpy, sys
argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)
bpy.ops.export_scene.gltf(
    filepath=dst, export_format='GLB',
    export_animations=True, export_skins=True, export_apply=False,
)
`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'phy-fbx-'));
  const py = path.join(tmp, 'convert.py');
  writeFileSync(py, script);
  try {
    execFileSync(blender, ['--background', '--python', py, '--', srcFbx, dstGlb], { stdio: 'pipe' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!existsSync(dstGlb)) throw new Error('Blender no produjo el GLB');
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

/** ¿Todas las prims skinned conservan JOINTS_0/WEIGHTS_0? Y hay al menos un skin. */
function validateSkinning(document) {
  const skins = document.getRoot().listSkins().length;
  let skinnedPrims = 0;
  let brokenPrims = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const hasJoints = prim.getAttribute('JOINTS_0');
      const hasWeights = prim.getAttribute('WEIGHTS_0');
      if (hasJoints || hasWeights) {
        skinnedPrims++;
        if (!hasJoints || !hasWeights) brokenPrims++;
      }
    }
  }
  return { skins, skinnedPrims, brokenPrims };
}

/** Vacía normal/occlusion/metallicRoughness de todos los materiales (conserva baseColor + emissive). */
function stripPBRMaps(document) {
  const stripped = new Set();
  for (const material of document.getRoot().listMaterials()) {
    if (material.getNormalTexture()) { material.setNormalTexture(null); stripped.add('normal'); }
    if (material.getOcclusionTexture()) { material.setOcclusionTexture(null); stripped.add('occlusion'); }
    if (material.getMetallicRoughnessTexture()) { material.setMetallicRoughnessTexture(null); stripped.add('metallicRoughness'); }
  }
  return [...stripped];
}

async function main() {
  console.log('Pipeline de avatares (rig-safe: sin weld / sin simplify agresivo)\n');

  if (!existsSync(SRC_DIR)) {
    console.log(`No existe ${SRC_DIR}. Crea la carpeta y coloca los GLB/FBX riggeados.`);
    return;
  }
  const inputs = readdirSync(SRC_DIR).filter((f) => /\.(glb|fbx)$/i.test(f));
  if (inputs.length === 0) {
    console.log(`Sin entradas en ${SRC_DIR} (nada .glb/.fbx). Nada que hacer.`);
    console.log('Cuando lleguen los riggeados (nómbralos hacker-m.glb, …), vuelve a correr esto.');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const blender = findBlender();
  const needsBlender = inputs.some((f) => /\.fbx$/i.test(f));
  if (needsBlender && !blender) {
    throw new Error('Hay .fbx pero no se encontró blender.exe en "C:/Program Files/Blender Foundation".');
  }
  if (needsBlender) console.log(`Blender para FBX→GLB: ${blender}\n`);

  await MeshoptEncoder.ready;
  if (DO_SIMPLIFY) await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });

  const manifest = { generado: new Date().toISOString(), texturas: 'webp', avatares: [] };
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'phy-avatars-'));

  try {
    for (const input of inputs) {
      const srcPath = path.join(SRC_DIR, input);
      const base = input.replace(/\.(glb|fbx)$/i, '').toLowerCase();
      const outName = `${base}.glb`;
      const outPath = path.join(OUT_DIR, outName);
      const notas = [];
      const srcBytes = statSync(srcPath).size;

      console.log(`── ${input} (${(srcBytes / 1e6).toFixed(2)} MB) → ${outName}`);

      // 1. FBX → GLB si hace falta.
      let glbInput = srcPath;
      if (/\.fbx$/i.test(input)) {
        glbInput = path.join(tmpRoot, `${base}.glb`);
        fbxToGlb(blender, srcPath, glbInput);
        notas.push('FBX→GLB (Blender)');
      }

      const document = await io.read(glbInput);
      const trisAntes = countTriangles(document);
      const clipsAntes = document.getRoot().listAnimations().length;
      const skinAntes = validateSkinning(document);

      // 2. Poda PBR (conserva baseColor + emissive).
      const stripped = stripPBRMaps(document);
      if (stripped.length) notas.push(`PBR podado: ${stripped.join(', ')}`);

      // 3. Limpieza segura para rig (NADA de weld). resample compacta keyframes.
      //    prune SOLO sobre recursos sin riesgo (texturas/materiales/accesores
      //    huérfanos tras la poda PBR); NUNCA skins ni animaciones ni nodos, para
      //    no desmontar el esqueleto.
      await document.transform(
        dedup(),
        resample(),
        prune({
          propertyTypes: [
            PropertyType.ACCESSOR,
            PropertyType.MATERIAL,
            PropertyType.TEXTURE,
          ],
        }),
      );

      // 3b. Simplify CONSERVADOR opcional (opt-in; preserva bordes de skin).
      if (DO_SIMPLIFY) {
        await document.transform(
          simplify({ simplifier: MeshoptSimplifier, ratio: 0.9, error: 0.0005, lockBorder: true }),
        );
        notas.push('simplify conservador 0.9/0.0005 (lockBorder)');
      }

      // 4. Texturas → WebP 1024.
      await document.transform(
        textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEXTURE_SIZE, TEXTURE_SIZE] }),
      );

      // 5. quantize + EXT_meshopt_compression (limpio con skin + animación).
      //    El cleanup interno de meshopt es reference-aware: sólo retira recursos
      //    HUÉRFANOS (nunca un skin/clip en uso por un avatar bien riggeado). La
      //    red de seguridad real es la validación de skinning del paso 6.
      await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));

      // 6. Validación de rig.
      const clipsDespues = document.getRoot().listAnimations().length;
      const skinDespues = validateSkinning(document);
      const trisDespues = countTriangles(document);

      if (skinDespues.skins === 0) notas.push('⚠ SIN SKIN tras el pipeline');
      if (skinDespues.brokenPrims > 0) notas.push(`⚠ ${skinDespues.brokenPrims} prim(s) con skin roto`);
      if (clipsDespues !== clipsAntes) notas.push(`⚠ clips ${clipsAntes}→${clipsDespues}`);

      await io.write(outPath, document);
      const outBytes = statSync(outPath).size;
      if (outBytes > TARGET_BYTES) notas.push(`⚠ ${(outBytes / 1024).toFixed(0)} KB > objetivo 700 KB`);

      const skinMsg = skinDespues.skins > 0 && skinDespues.brokenPrims === 0 ? 'skin OK' : 'skin ⚠';
      console.log(
        `   tris ${trisAntes.toLocaleString()} → ${trisDespues.toLocaleString()} | ` +
        `clips ${clipsAntes} | ${skinMsg} | ` +
        `${(srcBytes / 1e6).toFixed(2)} MB → ${(outBytes / 1024).toFixed(1)} KB` +
        (notas.length ? `\n   notas: ${notas.join(' · ')}` : '') + '\n',
      );

      manifest.avatares.push({
        archivo: outName,
        fuente: input,
        bytes: outBytes,
        bytesFuente: srcBytes,
        tris: trisDespues,
        clips: clipsDespues,
        clipNombres: document.getRoot().listAnimations().map((a) => a.getName()),
        skin: skinDespues,
        textura: { formato: 'webp', resolucion: TEXTURE_SIZE },
        compresion: 'EXT_meshopt_compression',
        notas,
      });
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const totalBytes = manifest.avatares.reduce((s, a) => s + a.bytes, 0);
  manifest.totalBytes = totalBytes;
  writeFileSync(path.join(OUT_DIR, 'avatars-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `TOTAL: ${(totalBytes / 1024).toFixed(1)} KB en ${manifest.avatares.length} avatar(es) — ` +
    `manifest en apps/web/public/assets/avatars/avatars-manifest.json`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
