/**
 * validate.mjs — Valida el GLB del avatar "nube" generado por generate.py.
 *
 * NUEVA DIRECCIÓN (S8): un ÚNICO diseño NEUTRO tipo plastilina ("nube.glb"),
 * un solo volumen suave, SÓLO ojos, sin arquetipos/builds. Comprueba, por cada
 * apps/web/public/assets/avatars/gen/*.glb:
 *   · Huesos Mixamo esperados presentes (cadena completa + piernas de locomoción).
 *   · ≤ 6000 triángulos (más denso que S7: la suavidad clay lo pide).
 *   · El material nombrado: body (cuerpo, zona de tinte). Los ojos ya NO se
 *     hornean en la malla — los anima el engine (ExpressiveEyes).
 *   · Skin presente con JOINTS_0/WEIGHTS_0 en las primitivas (skinning suave).
 *   · Tamaño < 300 KB.
 *
 * Uso:  cd tools/assets && node ../avatars/validate.mjs
 * (usa @gltf-transform/core de tools/assets/node_modules)
 */
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

// Resuelve las deps desde tools/assets/node_modules (donde ya están instaladas).
const require = createRequire(path.join(REPO, "tools", "assets", "package.json"));
const importFrom = async (pkg) => import(pathToFileURL(require.resolve(pkg)).href);
const { NodeIO } = await importFrom("@gltf-transform/core");
const { ALL_EXTENSIONS } = await importFrom("@gltf-transform/extensions");
const { MeshoptDecoder } = await importFrom("meshoptimizer");
const draco3d = (await importFrom("draco3dgltf")).default;
const GEN_DIR = path.join(REPO, "apps", "web", "public", "assets", "avatars", "gen");

const MAX_TRIS = 6000;
const MAX_BYTES = 300 * 1024;
// El avatar "nube" tiene 1 material nombrado: body (tintable). Los ojos los pone
// el engine (ExpressiveEyes), ya no se hornean en la malla.
const ZONES = ["body"];
// Huesos mínimos que ProceduralLocomotion necesita + cadena razonable.
const REQUIRED_BONES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftUpLeg", "LeftLeg", "LeftFoot",
  "RightUpLeg", "RightLeg", "RightFoot",
  "LeftArm", "LeftForeArm", "LeftHand",
  "RightArm", "RightForeArm", "RightHand",
];

function normBone(name) {
  return name.toLowerCase().replace(/^mixamorig[:_]?/, "").replace(/_\d+$/, "");
}

function countTris(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute("POSITION");
      if (idx) tris += idx.getCount() / 3;
      else if (pos) tris += pos.getCount() / 3;
    }
  }
  return Math.round(tris);
}

function validateSkin(doc) {
  const skins = doc.getRoot().listSkins().length;
  let skinned = 0, broken = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const j = prim.getAttribute("JOINTS_0");
      const w = prim.getAttribute("WEIGHTS_0");
      if (j || w) {
        skinned++;
        if (!j || !w) broken++;
      }
    }
  }
  return { skins, skinned, broken };
}

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "meshopt.decoder": MeshoptDecoder,
  });

  let files;
  try {
    files = readdirSync(GEN_DIR).filter((f) => f.endsWith(".glb")).sort();
  } catch {
    console.error("No existe", GEN_DIR, "— corre generate.py primero.");
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("Sin GLB en", GEN_DIR);
    process.exit(1);
  }

  let pass = 0, fail = 0;
  for (const file of files) {
    const p = path.join(GEN_DIR, file);
    const bytes = statSync(p).size;
    const doc = await io.read(p);
    const problems = [];

    // Huesos
    const nodeNames = doc.getRoot().listNodes().map((n) => normBone(n.getName() || ""));
    const nodeSet = new Set(nodeNames);
    const missing = REQUIRED_BONES.filter((b) => !nodeSet.has(b.toLowerCase()));
    if (missing.length) problems.push(`faltan huesos: ${missing.join(",")}`);

    // Tris
    const tris = countTris(doc);
    if (tris > MAX_TRIS) problems.push(`tris ${tris} > ${MAX_TRIS}`);

    // Materiales
    const matNames = new Set(doc.getRoot().listMaterials().map((m) => (m.getName() || "").toLowerCase()));
    const missMat = ZONES.filter((z) => !matNames.has(z));
    if (missMat.length) problems.push(`faltan materiales: ${missMat.join(",")}`);

    // Skin
    const skin = validateSkin(doc);
    if (skin.skins === 0) problems.push("SIN skin");
    if (skin.broken > 0) problems.push(`${skin.broken} prim(s) skin roto`);

    // Tamaño
    if (bytes >= MAX_BYTES) problems.push(`${(bytes / 1024).toFixed(0)}KB >= 300KB`);

    const ok = problems.length === 0;
    if (ok) pass++; else fail++;
    console.log(
      `${ok ? "OK  " : "FAIL"}  ${file.padEnd(18)} tris=${String(tris).padStart(4)} ` +
      `mats=${matNames.size} skin=${skin.skins} ${(bytes / 1024).toFixed(1)}KB` +
      (ok ? "" : `\n        ${problems.join(" · ")}`),
    );
  }

  console.log("─".repeat(60));
  console.log(`${pass} OK · ${fail} FAIL de ${files.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
