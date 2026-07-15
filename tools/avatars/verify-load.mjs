/**
 * verify-load.mjs — Carga un GLB generado con el MISMO loader que el runtime
 * (three GLTFLoader) y comprueba lo que el engine necesita:
 *   · Se crean THREE.Bone para los huesos Mixamo (piernas incluidas).
 *   · Los huesos mínimos de ProceduralLocomotion están (hips + 2×UpLeg + 2×Leg).
 *   · Hay una SkinnedMesh con skeleton enlazado.
 *   · Los 5 materiales nombrados por zona sobreviven.
 *
 * Uso:  cd tools/assets && node ../avatars/verify-load.mjs [archivo.glb]
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const GEN = path.join(REPO, "apps", "web", "public", "assets", "avatars", "gen");

// three + GLTFLoader desde apps/web/node_modules (misma versión que el runtime).
const require = createRequire(path.join(REPO, "apps", "web", "package.json"));
const THREE = await import(pathToFileURL(require.resolve("three")).href);
const { GLTFLoader } = await import(
  pathToFileURL(require.resolve("three/examples/jsm/loaders/GLTFLoader.js")).href
);

function normBone(n) {
  return n.toLowerCase().replace(/^mixamorig[:_]?/, "").replace(/_\d+$/, "");
}
const REQUIRED = ["hips", "leftupleg", "rightupleg", "leftleg", "rightleg", "leftfoot", "rightfoot", "head"];
const ZONES = ["primary", "secondary", "hair", "skin", "accent"];

const file = process.argv[2] || readdirSync(GEN).filter((f) => f.endsWith(".glb")).sort()[0];
const glbPath = path.isAbsolute(file) ? file : path.join(GEN, file);
const buf = readFileSync(glbPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
loader.parse(
  ab,
  "",
  (gltf) => {
    const bones = [];
    let skinned = null;
    const mats = new Set();
    gltf.scene.traverse((o) => {
      if (o.isBone) bones.push(normBone(o.name));
      if (o.isSkinnedMesh) skinned = o;
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => x.name && mats.add(x.name.toLowerCase()));
    });
    const boneSet = new Set(bones);
    const missingBones = REQUIRED.filter((b) => !boneSet.has(b));
    const missingMats = ZONES.filter((z) => !mats.has(z));
    const hasSkeleton = !!(skinned && skinned.skeleton && skinned.skeleton.bones.length);

    console.log(`Archivo: ${path.basename(glbPath)}`);
    console.log(`  Bones (THREE.Bone): ${bones.length}`);
    console.log(`  SkinnedMesh: ${skinned ? "sí" : "NO"} · skeleton bones: ${hasSkeleton ? skinned.skeleton.bones.length : 0}`);
    console.log(`  Materiales: ${[...mats].sort().join(", ")}`);
    const ok = missingBones.length === 0 && missingMats.length === 0 && hasSkeleton;
    if (missingBones.length) console.log(`  FALTAN huesos: ${missingBones.join(", ")}`);
    if (missingMats.length) console.log(`  FALTAN materiales: ${missingMats.join(", ")}`);
    console.log(ok ? "  => OK: carga como esqueleto skinned con huesos de pierna + 5 zonas" : "  => FALLO");
    process.exit(ok ? 0 : 1);
  },
  (err) => {
    console.error("Error al parsear el GLB:", err);
    process.exit(1);
  },
);
