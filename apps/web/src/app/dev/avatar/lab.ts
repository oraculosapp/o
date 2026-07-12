import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  TestDummy,
  AvatarRig,
  type IAvatarRig,
  type AvatarDriveState,
  type TintZone,
  type Locomotion,
  type LocomotionQA,
} from "@phygitalia/engine";

export type LabMode = "idle" | "walk" | "run" | "jump";

/** Diagnóstico de clips que devuelve loadGlb (nombres reales + mapeo por locomoción). */
export interface ClipInfo {
  names: string[];
  mapping: Record<Locomotion, string | null>;
}

export type LoadResult = { ok: true; clips: ClipInfo } | { ok: false; error?: string };

/** Presets de estado de conducción por modo (para las animaciones del avatar). */
const DRIVE: Record<Exclude<LabMode, "jump">, AvatarDriveState> = {
  idle: { speed: 0, maxSpeed: 6, grounded: true, jumping: false },
  walk: { speed: 2.4, maxSpeed: 6, grounded: true, jumping: false },
  run: { speed: 6, maxSpeed: 6, grounded: true, jumping: false },
};

/**
 * Escena mínima de prueba de avatares (solo /dev): suelo toon, cielo gradiente,
 * el avatar en el centro y órbita con drag. Arranca con el TestDummy procedural
 * y puede intentar cargar un GLB real de Tripo3D en caliente.
 */
export class AvatarLab {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();

  private rig!: IAvatarRig;
  private mode: LabMode = "idle";
  private prevMode: Exclude<LabMode, "jump"> = "idle";
  private jumpUntil = 0;

  private rafId = 0;
  private disposed = false;
  private resizeObs?: ResizeObserver;

  constructor(private container: HTMLElement) {}

  start(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.w(), this.h());
    this.renderer.domElement.style.display = "block";
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xd8e0de, 0.012);

    this.camera = new THREE.PerspectiveCamera(45, this.w() / this.h(), 0.1, 200);
    this.camera.position.set(2.4, 1.8, 3.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = Math.PI * 0.9;

    this.buildEnvironment();

    // Avatar por defecto: el maniquí procedural.
    this.rig = new TestDummy();
    this.scene.add(this.rig.root);
    this.frameOnRig();

    // Handle de QA para validación (navegador/headless): window.__AVATARLAB__.
    (window as unknown as { __AVATARLAB__?: AvatarLab }).__AVATARLAB__ = this;

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    window.addEventListener("resize", this.onResize);

    this.loop();
  }

  private buildEnvironment(): void {
    // Cielo gradiente (esfera invertida).
    const skyGeo = new THREE.SphereGeometry(100, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0xe8ecea) },
        bottom: { value: new THREE.Color(0xc9d2ce) },
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vPos; void main(){ float h = clamp(normalize(vPos).y*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }`,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Suelo plano toon.
    const ramp = new Uint8Array([70, 70, 70, 255, 160, 160, 160, 255, 255, 255, 255, 255]);
    const gradientMap = new THREE.DataTexture(ramp, 3, 1, THREE.RGBAFormat);
    gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.needsUpdate = true;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(30, 48),
      new THREE.MeshToonMaterial({ color: 0x5c6b5a, gradientMap }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // Luz clave cálida + hemisférica (la niebla no ennegrece).
    const key = new THREE.DirectionalLight(0xf6dca0, 1.1);
    key.position.set(4, 8, 5);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xe8ecea, 0x3b4a3f, 0.95));
  }

  /** Reencuadra la cámara/controles al centro-torso del avatar actual. */
  private frameOnRig(): void {
    const midY = (this.rig.height || 1.6) * 0.5;
    this.controls.target.set(0, midY, 0);
    this.controls.update();
  }

  // ---- API pública para la UI ----

  setMode(mode: LabMode): void {
    if (mode === "jump") {
      this.jumpUntil = this.clock.elapsedTime + 0.9; // salto momentáneo
      this.mode = "jump";
    } else {
      this.prevMode = mode;
      this.mode = mode;
    }
  }

  setTint(palette: Partial<Record<TintZone, string>>): void {
    const out: Partial<Record<TintZone, THREE.Color>> = {};
    for (const zone of Object.keys(palette) as TintZone[]) {
      const hex = palette[zone];
      if (hex) out[zone] = new THREE.Color(hex);
    }
    this.rig.setTint(out);
  }

  /** Intenta cargar un GLB real; si funciona, reemplaza al avatar actual. */
  async loadGlb(name: string): Promise<LoadResult> {
    const url = `/assets/avatars/${name}.glb`;
    try {
      const rig = await AvatarRig.load(url, { dracoDecoderPath: "/draco/" });
      this.scene.remove(this.rig.root);
      this.rig.dispose();
      this.rig = rig;
      this.scene.add(rig.root);
      this.frameOnRig();
      this.setMode(this.mode === "jump" ? "idle" : this.mode);
      return { ok: true, clips: rig.clipInfo };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Muestra de QA para la validación (star deliverable): métricas del animador
   * procedural + posiciones de mundo de pies/manos/cadera para correlacionar fase
   * con distancia y verificar antifase sin patinaje. Devuelve null si el rig
   * actual no es procedural (maniquí o clips).
   */
  qa(): (LocomotionQA & { footL: number[]; footR: number[]; hipY: number; mode: LabMode }) | null {
    const rig = this.rig as { locomotionQA?: LocomotionQA | null };
    const metrics = rig.locomotionQA;
    if (!metrics) return null;
    const worldY = (substr: string): number[] => {
      let out: number[] = [NaN, NaN, NaN];
      const v = new THREE.Vector3();
      this.rig.root.traverse((o) => {
        if (out[0] === out[0]) return; // ya encontrado
        if (o.name.toLowerCase().includes(substr)) {
          o.getWorldPosition(v);
          out = [v.x, v.y, v.z];
        }
      });
      return out;
    };
    return {
      ...metrics,
      footL: worldY("leftfoot"),
      footR: worldY("rightfoot"),
      hipY: worldY("hips")[1],
      mode: this.mode,
    };
  }

  // ---- loop ----

  private driveState(): AvatarDriveState {
    if (this.mode === "jump") {
      if (this.clock.elapsedTime >= this.jumpUntil) this.mode = this.prevMode;
      else {
        const base = DRIVE[this.prevMode];
        return { speed: base.speed, maxSpeed: base.maxSpeed, grounded: false, jumping: true };
      }
    }
    return DRIVE[this.mode as Exclude<LabMode, "jump">];
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.rig.update(dt, this.driveState());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private w(): number {
    return this.container.clientWidth || window.innerWidth;
  }
  private h(): number {
    return this.container.clientHeight || window.innerHeight;
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
    this.disposed = true;
    const g = window as unknown as { __AVATARLAB__?: AvatarLab };
    if (g.__AVATARLAB__ === this) delete g.__AVATARLAB__;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.controls?.dispose();
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
