import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { IslandField } from "../island/IslandField";
import { makeToonRamp } from "../util/toon";

/**
 * Tótem de Paqo: el ancla del claro. Carga `paqo.glb` (EXT_texture_webp +
 * KHR_draco_mesh_compression) con GLTFLoader + DRACOLoader (decoder Draco
 * auto-hospedado en /draco/, sin CDNs), conserva su textura baseColor pero
 * re-ilumina a cel-shading (MeshToonMaterial + rim darkening en shader, en vez
 * de inverted-hull: 90k tris duplicados sería caro). Escala a ~8.5 u de alto y
 * lo posa en el centro del claro (+Y) mirando al spawn.
 */
export class Totem {
  readonly group = new THREE.Group();
  private disposed = false;
  private materials: THREE.Material[] = [];

  constructor(
    private field: IslandField,
    private opts: { url?: string; dracoPath?: string; targetHeight?: number } = {},
  ) {}

  /** Carga y coloca el tótem. Resuelve cuando ya está en la escena (o falla). */
  async load(scene: THREE.Scene): Promise<void> {
    const url = this.opts.url ?? "/assets/totems/paqo.glb";
    const dracoPath = this.opts.dracoPath ?? "/draco/";
    const targetHeight = this.opts.targetHeight ?? 8.5;

    const draco = new DRACOLoader();
    draco.setDecoderPath(dracoPath);
    draco.setDecoderConfig({ type: "wasm" });
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);

    try {
      const gltf = await loader.loadAsync(url);
      if (this.disposed) return;
      const model = gltf.scene;

      // Re-ilumina cada material a toon conservando su map baseColor.
      const ramp = makeToonRamp();
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = true;
        const src = mesh.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
        const one = Array.isArray(src) ? src[0] : src;
        const map = (one && "map" in one ? one.map : null) as THREE.Texture | null;
        const baseColor =
          one && "color" in one && one.color ? one.color.clone() : new THREE.Color(0xffffff);
        const toon = new THREE.MeshToonMaterial({
          map: map ?? null,
          color: map ? new THREE.Color(0xffffff) : baseColor,
          gradientMap: ramp,
        });
        this.applyRimDark(toon);
        mesh.material = toon;
        this.materials.push(toon);
      });

      // Escala a la altura objetivo desde su bounding box nativo.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const nativeH = Math.max(size.y, 1e-3);
      const scale = targetHeight / nativeH;
      model.scale.setScalar(scale);

      // Posa la base en el suelo del claro (origen), up = +Y mundial.
      const ground = this.field.surfacePoint(0, 0);
      // Tras escalar, el mínimo Y del modelo local queda en box.min.y*scale.
      const baseOffset = -box.min.y * scale;
      this.group.position.copy(ground).add(new THREE.Vector3(0, baseOffset - 0.15, 0));
      this.group.add(model);
      scene.add(this.group);
    } catch (err) {
      // El valle sigue siendo jugable sin el tótem; sólo se registra.
      console.error("[Totem] fallo al cargar", err);
    } finally {
      draco.dispose();
    }
  }

  /**
   * Rim darkening: oscurece los fragmentos a contraluz del borde (grazing
   * angle) para leer silueta "ilustrada" sin duplicar geometría.
   */
  private applyRimDark(mat: THREE.MeshToonMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
           float rimTerm = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));`,
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
           float rimDark = smoothstep(0.55, 1.0, rimTerm);
           gl_FragColor.rgb *= mix(1.0, 0.35, rimDark);`,
        );
    };
    mat.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.materials.forEach((m) => m.dispose());
  }
}
