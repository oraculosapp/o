import sharp from "sharp";
import { mkdirSync } from "node:fs";
const SRC = "D:/Oraculos/o/assets/avatares";
const OUT = "D:/Oraculos/o/apps/web/public/assets/avatars/thumbs";
mkdirSync(OUT, { recursive: true });
// Plantilla 1536x1024: columna FRENTE (1ª), fila masculina (arriba).
// Figura ~centrada en x500, cabeza y~130, pies y~460.
const REGION = { left: 372, top: 118, width: 250, height: 300 };
const MAP = {
  "1_hacker": "hacker", "2_licenciado": "licenciado", "3_godin": "godines",
  "4_artista": "artista", "5_Astronomo": "astronomo", "6_Vampiro": "vampiro",
  "7_Chaman-Curandero": "chaman", "8_Bodybuilder": "bodybuilder", "9_dedo-verde": "dedo-verde",
};
for (const [file, id] of Object.entries(MAP)) {
  try {
    await sharp(`${SRC}/${file}.png`)
      .extract(REGION)
      .resize(256, 256, { fit: "cover", position: "top" })
      .webp({ quality: 82 })
      .toFile(`${OUT}/${id}.webp`);
    console.log("ok", id);
  } catch (e) { console.log("ERR", id, e.message); }
}
