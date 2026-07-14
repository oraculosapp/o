import * as THREE from "three";
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  SelectiveBloomEffect,
  LUT3DEffect,
  LookupTexture,
  BlendFunction,
} from "postprocessing";
import { createMoodLUT, type MoodId } from "./MoodGrading";

/**
 * Bloom SELECTIVO (pmndrs/postprocessing): sólo los emisivos dorados de Paqo
 * (el anillo-runa del claro, y cualquier glifo emisivo) reciben glow — el resto
 * de la escena queda nítido. Degradable: en dispositivos débiles se salta el
 * composer y se renderiza directo (ver `shouldEnable`).
 */
export class BloomComposer {
  private composer?: EffectComposer;
  private bloom?: SelectiveBloomEffect;
  /** Pase de color grading (LUT 3D) — vive DESPUÉS del bloom en el mismo EffectPass. */
  private lut?: LUT3DEffect;
  /** Caché perezosa de las 7 LUTs de mood (se generan la 1ª vez que se piden). */
  private lutCache = new Map<MoodId, LookupTexture>();
  private currentMood: MoodId = "natural";
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

    // Color grading (LUT 3D) arranca en "natural" = LUT identidad (sin cambio
    // visual). Datos Float32 (HalfFloat framebuffer) + interpolación tetraédrica
    // = grading de alta precisión sin banding. El efecto va DESPUÉS del bloom en
    // el array del EffectPass: gradúa la imagen ya compuesta (escena + glow).
    const neutral = this.moodLUT("natural");
    const lut = new LUT3DEffect(neutral, { tetrahedralInterpolation: true });
    this.lut = lut;

    const composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
    });
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera, bloom, lut));
    this.composer = composer;
  }

  /** Obtiene (cacheando) la LookupTexture procedural de un mood. */
  private moodLUT(id: MoodId): LookupTexture {
    let tex = this.lutCache.get(id);
    if (!tex) {
      tex = createMoodLUT(id);
      this.lutCache.set(id, tex);
    }
    return tex;
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

  /**
   * Aplica un "mood" de color grading (LUT 3D) al pase final de post-proceso.
   * Si el composer está desactivado (fallback móvil), es no-op silencioso.
   * "natural" carga la LUT identidad (sin cambio visual). Cachea las 7 LUTs.
   */
  setMood(id: MoodId): void {
    if (!this.lut) return; // composer apagado → silencioso
    if (id === this.currentMood && this.lut.lut) return;
    this.lut.lut = this.moodLUT(id);
    this.currentMood = id;
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
    for (const tex of this.lutCache.values()) tex.dispose();
    this.lutCache.clear();
  }
}
