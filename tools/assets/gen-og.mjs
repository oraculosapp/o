// gen-og.mjs — genera la imagen OpenGraph (1200×630) de Phygitalia.
//
// Compone, sobre el fondo cósmico de marca: el isotipo oracular teñido de oro,
// el logotipo ORÁCULOS (también dorado) y la bajada, con Chakra Petch embebida.
//
// Salida → apps/web/public/og.png
// Uso:    node tools/assets/gen-og.mjs

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const EXPO = "D:/Oraculos/Exposicion/assets";
const OUT = resolve(REPO, "apps/web/public/og.png");
const FONT = resolve(REPO, "apps/web/public/fonts/ChakraPetch-SemiBold.ttf");

const W = 1200;
const H = 630;
const GOLD = { r: 0xe3, g: 0xb0, b: 0x63 };

// Silueta dorada (gold RGB + alfa del arte) de un PNG de línea negra.
async function goldFrom(srcPath, targetH) {
  const resized = await sharp(srcPath).resize({ height: targetH }).toBuffer();
  const { width, height } = await sharp(resized).metadata();
  const alpha = await sharp(resized).extractChannel("alpha").toColourspace("b-w").toBuffer();
  const buf = await sharp({
    create: { width, height, channels: 3, background: GOLD },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  return { buf, width, height };
}

function cosmosSvg() {
  return Buffer.from(`
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="terra" cx="20%" cy="18%" r="60%">
      <stop offset="0%" stop-color="#c98a5e" stop-opacity="0.28"/>
      <stop offset="60%" stop-color="#c98a5e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="indigo" cx="85%" cy="22%" r="65%">
      <stop offset="0%" stop-color="#506096" stop-opacity="0.30"/>
      <stop offset="65%" stop-color="#506096" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="goldglow" cx="50%" cy="86%" r="55%">
      <stop offset="0%" stop-color="#e3b063" stop-opacity="0.14"/>
      <stop offset="60%" stop-color="#e3b063" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0c16"/>
      <stop offset="45%" stop-color="#0b0d18"/>
      <stop offset="100%" stop-color="#0a0b13"/>
    </linearGradient>
    <radialGradient id="vig" cx="50%" cy="42%" r="75%">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#04050a" stop-opacity="0.55"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#base)"/>
  <rect width="${W}" height="${H}" fill="url(#terra)"/>
  <rect width="${W}" height="${H}" fill="url(#indigo)"/>
  <rect width="${W}" height="${H}" fill="url(#goldglow)"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
</svg>`);
}

async function textSvg() {
  const font = await readFile(FONT);
  const b64 = font.toString("base64");
  return Buffer.from(`
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <style>
    @font-face {
      font-family: "Chakra Petch";
      src: url("data:font/ttf;base64,${b64}") format("truetype");
    }
    .eyebrow {
      font-family: "Chakra Petch", sans-serif;
      font-size: 30px; letter-spacing: 14px; fill: #e3b063;
    }
    .tagline {
      font-family: "Chakra Petch", sans-serif;
      font-size: 34px; letter-spacing: 4px; fill: #efe7d7;
    }
  </style>
  <text x="50%" y="150" text-anchor="middle" class="eyebrow">PHYGITALIA</text>
  <text x="50%" y="540" text-anchor="middle" class="tagline">El mundo de los Or&#225;culos Tel&#250;rico-Sint&#233;ticos</text>
</svg>`);
}

async function main() {
  const iso = await goldFrom(`${EXPO}/isotipo-a.png`, 210);
  const logo = await goldFrom(`${EXPO}/oraculos-logotipo.png`, 150);

  const isoLeft = Math.round((W - iso.width) / 2);
  const logoLeft = Math.round((W - logo.width) / 2);

  await sharp(cosmosSvg())
    .composite([
      { input: iso.buf, top: 190, left: isoLeft },
      { input: logo.buf, top: 360, left: logoLeft },
      { input: await textSvg(), top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  const { stat } = await import("node:fs/promises");
  const { size } = await stat(OUT);
  console.log(`og.png  ${W}×${H}  ${(size / 1024).toFixed(1)} KB → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
