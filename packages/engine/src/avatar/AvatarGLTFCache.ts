import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AvatarRig, type AvatarRigOptions } from "./AvatarRig";

/**
 * Caché de GLTFs de arquetipo compartida por URL.
 *
 * Motivo: en una escena multijugador varios remotos pueden llevar el mismo
 * arquetipo. Cargar el GLB una sola vez y clonar la escena skinned con
 * `SkeletonUtils.clone` (que duplica huesos + bindings correctamente) evita N
 * descargas y N parseos. Los `AnimationClip` son inmutables y se comparten entre
 * mixers; cada clon crea sus propios materiales toon (uniforms de tinte
 * independientes) leyendo — sin mutar ni liberar — los materiales/texturas fuente.
 *
 * Se cachea la *promesa* del GLTF (no el rig), porque un `AvatarRig`/`Object3D`
 * no puede estar en dos sitios de la escena a la vez.
 */
const cache = new Map<string, Promise<GLTF>>();

function loadGLTF(url: string, opts?: AvatarRigOptions): Promise<GLTF> {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(opts?.dracoDecoderPath ?? "/draco/");
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.loadAsync(url).finally(() => draco.dispose());
}

/**
 * Devuelve un `AvatarRig` nuevo (clon independiente) para `url`, reutilizando el
 * GLTF cacheado. Si la carga falla (p.ej. 404 porque el arquetipo aún no existe),
 * la promesa rechaza y la entrada se purga para poder reintentar más tarde.
 */
export async function loadAvatarRigShared(
  url: string,
  opts?: AvatarRigOptions,
): Promise<AvatarRig> {
  let pending = cache.get(url);
  if (!pending) {
    pending = loadGLTF(url, opts);
    cache.set(url, pending);
    // No dejar en caché una carga fallida.
    pending.catch(() => cache.delete(url));
  }
  const gltf = await pending;
  const scene = skeletonClone(gltf.scene) as THREE.Group;
  return AvatarRig.fromGLTF(
    { scene, animations: gltf.animations },
    { ...opts, disposeSource: false },
  );
}

/** Purga la caché (test / cambio de sesión). No libera clones ya instanciados. */
export function clearAvatarGLTFCache(): void {
  cache.clear();
}
