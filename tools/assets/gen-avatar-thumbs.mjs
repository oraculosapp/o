/**
 * gen-avatar-thumbs.mjs — miniaturas cuadradas de los arquetipos para el selector.
 *
 * Las láminas (D:\Oraculos\o\assets\avatares\<n>_<arquetipo>.png) son fichas con
 * panel de info a la izquierda y dos filas de vistas (M arriba, F abajo, 4 vistas
 * cada una). Recortamos la vista FRONTAL masculina (primera columna, fila superior)
 * en un cuadrado y la exportamos a WebP ~200px.
 *
 * Salida → apps/web/public/assets/avatars/thumbs/<arquetipo>.webp
 *
 * Uso:  node tools/assets/gen-avatar-thumbs.mjs
 * Determinista y sin red: los WebP se versionan (arte homologado del selector).
 */

import sharp from 'sharp';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const SRC = resolve(REPO, 'assets/avatares');
const OUT = resolve(REPO, 'apps/web/public/assets/avatars/thumbs');
const SIZE = 200;

// id de arquetipo → lámina de origen (docs/avatares-tripo3d.md §2).
const SHEETS = [
  { id: 'hacker', file: '1_hacker.png' },
  { id: 'godines', file: '3_godin.png' },
  { id: 'artista', file: '4_artista.png' },
  { id: 'licenciado', file: '2_licenciado.png' },
  { id: 'vampiro', file: '6_Vampiro.png' },
  { id: 'astronomo', file: '5_Astronomo.png' },
  { id: 'chaman', file: '7_Chaman-Curandero.png' },
  { id: 'bodybuilder', file: '8_Bodybuilder.png' },
  { id: 'dedo-verde', file: '9_dedo-verde.png' },
];

// Recorte proporcional de la vista FRONTAL masculina (primera columna, fila M).
// Fracciones respecto al ancho/alto de la lámina (layout consistente entre fichas).
const CROP = { cx: 0.33, cy: 0.29, side: 0.4 }; // centro X/Y y lado del cuadrado (× alto)

async function thumb({ id, file }) {
  const src = resolve(SRC, file);
  if (!existsSync(src)) {
    console.warn(`  · ${file} no existe — se omite ${id}`);
    return false;
  }
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const side = Math.round(H * CROP.side);
  const left = Math.max(0, Math.min(W - side, Math.round(W * CROP.cx - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round(H * CROP.cy - side / 2)));

  const out = resolve(OUT, `${id}.webp`);
  await sharp(src)
    .extract({ left, top, width: side, height: side })
    .resize(SIZE, SIZE, { fit: 'cover' })
    .webp({ quality: 82 })
    .toFile(out);
  const { size } = await stat(out);
  console.log(`  ${id.padEnd(12)} ${SIZE}px  ${(size / 1024).toFixed(1)} KB`);
  return true;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('Generando miniaturas de arquetipos →', OUT);
  let n = 0;
  for (const sheet of SHEETS) {
    if (await thumb(sheet)) n++;
  }
  console.log(`Listo: ${n}/${SHEETS.length} miniaturas.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
