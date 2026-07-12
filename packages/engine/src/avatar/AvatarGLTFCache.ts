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

/** Prefijo same-origin permitido para los GLB de arquetipo. */
const AVATAR_PATH_PREFIX = "/assets/avatars/";

/**
 * Allowlist de URLs de arquetipo (M-5). El `archetype` de un remoto llega por
 * broadcast de Realtime y NO es de fiar: un emisor malicioso podría enviar una
 * URL externa arbitraria y hacer que TODAS las víctimas la descarguen (fetch a
 * un host atacante) al pasarla al GLTFLoader. Sólo aceptamos rutas same-origin
 * bajo `/assets/avatars/`:
 *   · rutas relativas que empiezan por el prefijo, o
 *   · URLs absolutas cuyo origin == location.origin y pathname bajo el prefijo.
 * Rechaza data:, blob:, http(s) externos, path traversal, etc.
 */
export function isAllowedArchetypeUrl(url: string | undefined | null): url is string {
  if (!url || typeof url !== "string") return false;
  // Sin path traversal ni backslashes que despisten al parser.
  if (url.includes("..") || url.includes("\\")) return false;
  const origin =
    typeof location !== "undefined" && location.origin && location.origin !== "null"
      ? location.origin
      : "http://localhost";
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  return parsed.pathname.startsWith(AVATAR_PATH_PREFIX);
}

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
  // Guardarraíl de seguridad (M-5): nunca cargamos una URL fuera de la allowlist,
  // aunque un caller se salte la validación previa. El caller cachea el fallo y
  // se queda con el maniquí.
  if (!isAllowedArchetypeUrl(url)) {
    throw new Error(`Arquetipo rechazado (URL no permitida): ${url}`);
  }
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
