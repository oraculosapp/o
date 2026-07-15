/**
 * thumbs.mjs — Convierte los thumbnails PNG que renderiza generate.py a WebP.
 *
 * generate.py escribe apps/web/public/assets/avatars/thumbs/gen/<id>.png (512px,
 * fondo transparente). Este paso los pasa a .webp (más ligeros) que consume la web
 * (AvatarPicker / HudControls / ProfileForm vía thumbUrl()). Los PNG se conservan
 * por si hace falta re-render; la web sólo usa los .webp.
 *
 * Uso:  cd tools/assets && node ../avatars/thumbs.mjs
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const DIR = path.join(REPO, "apps", "web", "public", "assets", "avatars", "thumbs", "gen");

const require = createRequire(path.join(REPO, "tools", "assets", "package.json"));
const sharp = (await import(pathToFileURL(require.resolve("sharp")).href)).default;

const pngs = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
if (pngs.length === 0) {
  console.error("Sin PNG en", DIR, "— corre generate.py primero.");
  process.exit(1);
}

let total = 0;
for (const png of pngs) {
  const src = path.join(DIR, png);
  const dst = src.replace(/\.png$/, ".webp");
  // 1) Recorta el margen transparente (normaliza el encuadre entre arquetipos con
  //    alturas distintas por sombreros). 2) Añade ~10% de aire alrededor para que
  //    el avatar no toque los bordes. 3) Cuadra a 512 transparente.
  const trimmed = await sharp(src).trim({ threshold: 10 }).png().toBuffer();
  const m = await sharp(trimmed).metadata();
  const pad = Math.round(Math.max(m.width, m.height) * 0.1);
  await sharp(trimmed)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 88, effort: 5 })
    .toFile(dst);
  const kb = statSync(dst).size / 1024;
  total += statSync(dst).size;
  // Borra el PNG intermedio (la web sólo usa el webp).
  unlinkSync(src);
  console.log(`  ${png.replace(/\.png$/, ".webp").padEnd(20)} ${kb.toFixed(1)} KB`);
}
console.log("─".repeat(48));
console.log(`${pngs.length} thumbnails → ${(total / 1024).toFixed(1)} KB total en ${DIR}`);
