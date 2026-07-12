// gen-icons.mjs — genera los iconos PWA de Phygitalia desde el isotipo oracular.
//
// El isotipo (D:\Oraculos\Exposicion\assets\isotipo-a.png) es arte de línea negro
// sobre alfa. Lo teñimos de oro (--gold) usando su canal alfa como máscara y lo
// componemos, con padding de zona segura, sobre el fondo cósmico de marca.
//
// Salidas → apps/web/public/icons/:
//   icon-192.png, icon-512.png            (any — con padding cómodo)
//   icon-maskable-192.png, -512.png       (maskable — silueta dentro del 80% seguro)
//   apple-touch-icon.png (180)            (fondo opaco, sin transparencia)
//   favicon.png (48)                      (marca en la pestaña)
//
// Uso:  node tools/assets/gen-icons.mjs
//
// Determinista y sin red: se puede re-ejecutar en CI. Los PNG resultantes se
// versionan en el repo (son el arte homologado de la app).

import sharp from "sharp";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const SRC = "D:/Oraculos/Exposicion/assets/isotipo-a.png";
const OUT = resolve(REPO, "apps/web/public/icons");

// Paleta de marca (hex exactos de tokens.css).
const GOLD = { r: 0xe3, g: 0xb0, b: 0x63 };
const BG_0 = "#080a12";

// Fondo cósmico cuadrado (mismos gradientes que la nebulosa de la landing).
function cosmosSvg(size) {
  return Buffer.from(`
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="terra" cx="22%" cy="16%" r="70%">
      <stop offset="0%" stop-color="#c98a5e" stop-opacity="0.30"/>
      <stop offset="60%" stop-color="#c98a5e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="indigo" cx="82%" cy="24%" r="75%">
      <stop offset="0%" stop-color="#506096" stop-opacity="0.32"/>
      <stop offset="65%" stop-color="#506096" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="goldglow" cx="50%" cy="82%" r="60%">
      <stop offset="0%" stop-color="#e3b063" stop-opacity="0.16"/>
      <stop offset="60%" stop-color="#e3b063" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0c16"/>
      <stop offset="45%" stop-color="#0b0d18"/>
      <stop offset="100%" stop-color="#0a0b13"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#base)"/>
  <rect width="100" height="100" fill="url(#terra)"/>
  <rect width="100" height="100" fill="url(#indigo)"/>
  <rect width="100" height="100" fill="url(#goldglow)"/>
</svg>`);
}

// Silueta dorada del isotipo: gold RGB con alfa = alfa del arte original.
async function goldSilhouette(targetH) {
  // Redimensionamos el arte a un búfer concreto para conocer sus dimensiones
  // reales (metadata() sobre un pipeline sin materializar devuelve el original).
  const resized = await sharp(SRC).resize({ height: targetH }).toBuffer();
  const { width, height } = await sharp(resized).metadata();
  // El canal alfa es la cobertura de tinta del dibujo.
  const alpha = await sharp(resized).extractChannel("alpha").toColourspace("b-w").toBuffer();
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: GOLD.r, g: GOLD.g, b: GOLD.b },
    },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  return { buf, width, height };
}

async function compose({ size, fill, out, opaque }) {
  // Altura objetivo de la silueta = fill * lienzo (limita por ser retrato).
  const targetH = Math.round(size * fill);
  const { buf, height } = await goldSilhouette(targetH);
  const glow = Math.round(size * 0.02);
  // Sombra dorada suave detrás de la silueta (coherente con la landing).
  const silhouetteWithGlow = await sharp(buf)
    .extend({
      top: glow,
      bottom: glow,
      left: glow,
      right: glow,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  let pipeline = sharp(cosmosSvg(size)).composite([
    { input: silhouetteWithGlow, gravity: "center" },
  ]);
  if (opaque) pipeline = pipeline.flatten({ background: BG_0 });
  await pipeline.png({ compressionLevel: 9 }).toFile(out);
  const { size: bytes } = await stat(out);
  console.log(`  ${out.split(/[\\/]/).pop().padEnd(26)} ${size}px  ${(bytes / 1024).toFixed(1)} KB`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log("Generando iconos PWA →", OUT);
  // any: padding cómodo (silueta ~0.72 de la altura).
  await compose({ size: 192, fill: 0.72, out: resolve(OUT, "icon-192.png") });
  await compose({ size: 512, fill: 0.72, out: resolve(OUT, "icon-512.png") });
  // maskable: silueta dentro del círculo seguro central (~0.58).
  await compose({ size: 192, fill: 0.58, out: resolve(OUT, "icon-maskable-192.png") });
  await compose({ size: 512, fill: 0.58, out: resolve(OUT, "icon-maskable-512.png") });
  // apple-touch: iOS recorta esquinas y no respeta transparencia → opaco.
  await compose({ size: 180, fill: 0.68, out: resolve(OUT, "apple-touch-icon.png"), opaque: true });
  // favicon de pestaña.
  await compose({ size: 48, fill: 0.82, out: resolve(OUT, "favicon.png") });
  console.log("Listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
