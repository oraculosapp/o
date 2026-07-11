import * as THREE from "three";
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  SelectiveBloomEffect,
  BlendFunction,
} from "postprocessing";

/**
 * Bloom SELECTIVO (pmndrs/postprocessing): sólo los emisivos dorados de Paqo
 * (el anillo-runa del claro, y cualquier glifo emisivo) reciben glow — el resto
 * de la escena queda nítido. Degradable: en dispositivos débiles se salta el
 * composer y se renderiza directo (ver `shouldEnable`).
 */
export class BloomComposer {
  private composer?: EffectComposer;
  private bloom?: SelectiveBloomEffect;
  readonly enabled: boolean;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    bloomIntensity = 0.3,
    forceEnabled?: boolean,
  ) {
    this.enabled = forceEnabled ?? BloomComposer.shouldEnable(renderer);
    if (!this.enabled) return;

    const bloom = new SelectiveBloomEffect(scene, camera, {
      blendFunction: BlendFunction.ADD,
      luminanceThreshold: 0.15,
      luminanceSmoothing: 0.25,
      // El preset trae 0.3 (glow sutil); se escala al rango de pmndrs.
      // ×2.5 (antes ×5): glow místico contenido — el anillo acompaña al tótem.
      intensity: Math.max(bloomIntensity, 0.25) * 2.5,
      mipmapBlur: true,
      radius: 0.7,
    });
    bloom.inverted = false; // florece la SELECCIÓN (emisivos), no el resto
    bloom.ignoreBackground = true;
    this.bloom = bloom;

    const composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
    });
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera, bloom));
    this.composer = composer;
  }

  /** Marca un objeto (y descendientes) como fuente de bloom. */
  addSelection(obj: THREE.Object3D): void {
    if (!this.bloom) return;
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.bloom!.selection.add(o);
    });
    if ((obj as THREE.Mesh).isMesh) this.bloom.selection.add(obj);
  }

  setSize(w: number, h: number): void {
    this.composer?.setSize(w, h);
  }

  /** Renderiza con bloom si está activo; si no, render directo. */
  render(dt: number): void {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Heurística de calidad: desactiva bloom en móviles débiles (poca resolución
   * efectiva y dpr alto = poco fill-rate). Presupuesto: 60 fps objetivo móvil.
   */
  static shouldEnable(renderer: THREE.WebGLRenderer): boolean {
    if (typeof window === "undefined") return true;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shortSide = Math.min(w, h);
    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    // Móvil táctil de pantalla pequeña con dpr alto → render directo.
    if (coarse && shortSide < 500 && dpr >= 2.5) return false;
    return true;
  }

  dispose(): void {
    this.composer?.dispose();
  }
}
