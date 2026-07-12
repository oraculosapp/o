import * as THREE from "three";

/**
 * Rampa toon de 3 bandas como DataTexture (gris) para `gradientMap`.
 * Compartida por terreno, avatar, runa y props — un solo look cel-shading.
 */
export function makeToonRamp(): THREE.DataTexture {
  // Rampa 3 bandas con LIFT MORADO en sombras y calidez ámbar en luces (multiplica
  // el color lit del material → toon global morado/ámbar barato, sin pass de post):
  //   sombra = malva profundo · medio = cálido neutro · luz = crema ámbar.
  const data = new Uint8Array([74, 66, 98, 255, 172, 165, 150, 255, 255, 252, 245, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Textura circular suave (canvas 2D) para motas de bruma, blobs y marcadores. */
export function makeSoftCircleTexture(inner = "rgba(255,255,255,0.95)"): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Añade un outline "inverted-hull": clona la geometría a BackSide con material
 * plano tinta y la escala ligeramente hacia fuera a lo largo de las normales.
 * Devuelve el mesh de outline (para poder disponerlo luego).
 */
export function addInvertedHullOutline(
  target: THREE.Mesh,
  color: THREE.ColorRepresentation,
  scale = 1.03,
): THREE.Mesh {
  const outlineMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    side: THREE.BackSide,
    fog: true,
  });
  const outline = new THREE.Mesh(target.geometry, outlineMat);
  outline.scale.setScalar(scale);
  target.add(outline);
  return outline;
}
