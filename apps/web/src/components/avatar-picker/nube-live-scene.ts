import * as THREE from "three";
import { loadAvatarRigShared, type IAvatarRig } from "@phygitalia/engine";
import { nubeGlbUrl } from "@/lib/avatars";

/**
 * NubeLivePreview — mini-visor 3D EN VIVO del avatar "nube" para el selector de
 * color. Monta su PROPIO renderer/contexto WebGL (fondo transparente, ligero) y
 * NO toca el mundo: es un segundo canvas chico que vive mientras el picker está
 * abierto y se libera por completo al cerrarse.
 *
 * · Carga `nube.glb` con `loadAvatarRigShared` (reutiliza el GLTF cacheado del
 *   mundo; el clon es independiente).
 * · Lo anima CAMINANDO EN EL SITIO: alimenta la locomoción con una velocidad
 *   constante (ratio walk ≈ 0.33) → las piernas Mixamo (ProceduralLocomotion)
 *   ciclan sin desplazar la raíz. Se le ven los ojitos (ExpressiveEyes) y parpadea.
 * · Tinte EN VIVO: `setColor(hex)` reaplica `rig.setTint({ primary })` al instante.
 * · `prefers-reduced-motion`: pose idle (parpadeo) sin caminar ni oscilar.
 * · Framerate moderado (≈30 fps) para no pelear con el mundo que sigue detrás.
 * · `dispose()` libera rig, escena, renderer y quita el canvas (sin fugas de
 *   contexto WebGL).
 */

/** Estado que hace CAMINAR al avatar en el sitio (ratio walk, sin salto/aire). */
const WALK: { speed: number; maxSpeed: number; grounded: boolean; jumping: boolean } = {
  speed: 2,
  maxSpeed: 6,
  grounded: true,
  jumping: false,
};
/** Estado idle (parado, respirando + parpadeo) para reduced-motion. */
const IDLE = { speed: 0, maxSpeed: 6, grounded: true, jumping: false };

/** Objetivo de framerate (fps): un canvas chico no necesita más y es más amable. */
const TARGET_FPS = 30;
const FRAME_DT = 1 / TARGET_FPS;

export interface NubeLivePreviewOptions {
  /** Color inicial del cuerpo (hex `#rrggbb`). */
  color: string;
  /** Sin caminar ni oscilar (idle + parpadeo). Default: detecta prefers-reduced-motion. */
  reducedMotion?: boolean;
  /** Se llama si WebGL falla o el GLB no carga → el caller cae al retrato estático. */
  onError?: () => void;
}

export class NubeLivePreview {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private pivot = new THREE.Group();
  private clock = new THREE.Clock();

  private rig?: IAvatarRig;
  private color: THREE.Color;
  private readonly reducedMotion: boolean;
  private readonly onError?: () => void;

  private rafId = 0;
  private acc = 0;
  private swayT = 0;
  private started = false;
  private disposed = false;
  private resizeObs?: ResizeObserver;

  constructor(
    private container: HTMLElement,
    opts: NubeLivePreviewOptions,
  ) {
    this.color = new THREE.Color(opts.color);
    this.reducedMotion =
      opts.reducedMotion ??
      (typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.onError = opts.onError;
  }

  /** Arranca el visor. Si el contexto WebGL no se puede crear, avisa por `onError`. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
    } catch {
      this.onError?.();
      return;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.w(), this.h());
    const cv = this.renderer.domElement;
    cv.style.display = "block";
    cv.style.width = "100%";
    cv.style.height = "100%";
    this.container.appendChild(cv);

    this.scene = new THREE.Scene();
    this.scene.add(this.pivot);

    // Cámara 3/4 frontal: encuadre de cuerpo entero (se ven piernas + ojitos).
    this.camera = new THREE.PerspectiveCamera(38, this.w() / this.h(), 0.1, 100);
    this.camera.position.set(0, 1.0, 4.4);
    this.camera.lookAt(0, 0.9, 0);

    // Luz cálida clave + rebote frío + relleno frontal (mismo espíritu que el mundo).
    const key = new THREE.DirectionalLight(0xffcf8a, 1.25);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb6ff, 0.4);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(0, 1.4, 5);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xf2bfc4, 0x4a3874, 0.9));

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);

    this.mountRig();
    this.loop();
  }

  /** Carga el GLB de nube y lo ancla al pivote (girado 180° para mostrar la CARA). */
  private mountRig(): void {
    loadAvatarRigShared(nubeGlbUrl())
      .then((rig) => {
        if (this.disposed) {
          rig.dispose();
          return;
        }
        rig.root.position.set(0, 0, 0);
        // El avatar mira a −Z (convención del mundo); la cámara está en +Z → 180°.
        rig.root.rotation.y = Math.PI;
        rig.setTint({ primary: this.color });
        this.pivot.add(rig.root);
        this.rig = rig;
      })
      .catch(() => {
        // 404 / GLB roto / red: el caller cae con gracia al retrato estático.
        if (!this.disposed) this.onError?.();
      });
  }

  /** Cambia el color del cuerpo EN VIVO (chip o picker libre). */
  setColor(hex: string): void {
    if (this.disposed) return;
    this.color.set(hex);
    this.rig?.setTint({ primary: this.color });
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    // Throttle a ≈30 fps: acumula dt real y sólo pinta cuando toca frame.
    this.acc += Math.min(this.clock.getDelta(), 0.1);
    if (this.acc < FRAME_DT) return;
    const dt = this.acc;
    this.acc = 0;

    if (!this.reducedMotion) {
      // Vista 3/4 viva: base ≈20° + vaivén suave (±13°) → nunca de perfil, los
      // ojitos siempre a la vista (no una vuelta completa que esconda la cara).
      this.swayT += dt;
      this.pivot.rotation.y = 0.35 + Math.sin(this.swayT * 0.6) * 0.22;
    } else {
      // Reduced-motion: 3/4 fijo (sin vaivén).
      this.pivot.rotation.y = 0.35;
    }
    this.rig?.update(dt, this.reducedMotion ? IDLE : WALK);
    this.renderer.render(this.scene, this.camera);
  };

  private w(): number {
    return this.container.clientWidth || 220;
  }
  private h(): number {
    return this.container.clientHeight || 220;
  }

  private onResize = (): void => {
    if (this.disposed) return;
    const w = this.w();
    const h = this.h();
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    this.rig?.dispose();
    this.rig = undefined;
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    const cv = this.renderer?.domElement;
    this.renderer?.dispose();
    if (cv && cv.parentElement) cv.parentElement.removeChild(cv);
  }
}
