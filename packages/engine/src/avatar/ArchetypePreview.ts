import * as THREE from "three";
import { buildArchetype } from "./archetypes";
import type { AvatarDriveState, IAvatarRig } from "./types";

/** Estado idle para el preview (parado, respirando). */
const IDLE: AvatarDriveState = { speed: 0, maxSpeed: 6, grounded: true, jumping: false };

export interface ArchetypePreviewOptions {
  /** Rota el avatar lentamente sobre su eje (default true). */
  autoRotate?: boolean;
  /** Velocidad de rotación (rad/s, default 0.5). */
  rotateSpeed?: number;
  /** Reproduce caminar en vez de idle (para depurar la locomoción, default false). */
  walk?: boolean;
}

/**
 * ArchetypePreview — mini-escena three.js AUTOCONTENIDA para mostrar UN arquetipo
 * en grande (el splash de selección la usa). No depende de PaqoWorld ni de ningún
 * asset: monta su propio renderer con fondo TRANSPARENTE, una luz toon cálida + un
 * rebote frío, coloca el avatar procedural centrado y lo hace girar despacio en
 * idle. `setArchetype` cambia de avatar en caliente; `dispose` limpia todo.
 *
 * Uso (React):
 * ```ts
 * const preview = new ArchetypePreview(containerEl, "hacker");
 * preview.start();
 * // al cambiar de selección:
 * preview.setArchetype("vampiro");
 * // al desmontar:
 * preview.dispose();
 * ```
 */
export class ArchetypePreview {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private pivot = new THREE.Group();

  private rig?: IAvatarRig;
  private angle = 0;
  private rafId = 0;
  private disposed = false;
  private started = false;
  private resizeObs?: ResizeObserver;

  private readonly autoRotate: boolean;
  private readonly rotateSpeed: number;
  private readonly walk: boolean;

  constructor(
    private container: HTMLElement,
    private archetypeId: string,
    opts?: ArchetypePreviewOptions,
  ) {
    this.autoRotate = opts?.autoRotate ?? true;
    this.rotateSpeed = opts?.rotateSpeed ?? 0.5;
    this.walk = opts?.walk ?? false;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0); // fondo transparente
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.w(), this.h());
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(this.pivot);

    this.camera = new THREE.PerspectiveCamera(38, this.w() / this.h(), 0.1, 100);
    this.camera.position.set(0, 1.0, 4.4);
    this.camera.lookAt(0, 0.9, 0);

    // Luz clave cálida (dorada) + rebote frío hemisférico (mismo espíritu que el mundo).
    const key = new THREE.DirectionalLight(0xffcf8a, 1.25);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb6ff, 0.4);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);
    // Relleno frontal suave (desde la cámara) para que la cara lea en avatares oscuros.
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(0, 1.4, 5);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xf2bfc4, 0x4a3874, 0.9));

    this.mountRig(this.archetypeId);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    window.addEventListener("resize", this.onResize);

    this.loop();
  }

  /** Cambia el arquetipo mostrado en caliente (reencuadra y reinicia el giro). */
  setArchetype(id: string): void {
    if (this.disposed || id === this.archetypeId) return;
    this.archetypeId = id;
    if (this.started) this.mountRig(id);
  }

  private mountRig(id: string): void {
    if (this.rig) {
      this.pivot.remove(this.rig.root);
      this.rig.dispose();
      this.rig = undefined;
    }
    const rig = buildArchetype(id);
    // Centra los pies en el origen del pivote (el rig nace con pies en y≈0).
    rig.root.position.set(0, 0, 0);
    // El avatar mira a −Z (convención del mundo); la cámara está en +Z. Giramos el
    // rig 180° para que el preview muestre la CARA (y la decoración del frente).
    rig.root.rotation.y = Math.PI;
    this.pivot.add(rig.root);
    this.rig = rig;
    this.angle = 0;
    this.pivot.rotation.y = 0;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.autoRotate) {
      this.angle += dt * this.rotateSpeed;
      this.pivot.rotation.y = this.angle;
    }
    this.rig?.update(dt, this.walk ? { speed: 2.4, maxSpeed: 6, grounded: true, jumping: false } : IDLE);
    this.renderer.render(this.scene, this.camera);
  };

  private w(): number {
    return this.container.clientWidth || 320;
  }
  private h(): number {
    return this.container.clientHeight || 420;
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
    window.removeEventListener("resize", this.onResize);
    this.rig?.dispose();
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    const el = this.renderer?.domElement;
    this.renderer?.dispose();
    if (el && el.parentElement) el.parentElement.removeChild(el);
  }
}
