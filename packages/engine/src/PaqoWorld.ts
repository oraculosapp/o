import * as THREE from "three";
import { Island } from "./island/Island";
import { CharacterController } from "./controller/CharacterController";
import { TestDummy } from "./avatar/TestDummy";
import { FollowCamera } from "./camera/FollowCamera";
import { InputManager } from "./input/InputManager";
import { makeToonRamp } from "./util/toon";
import { Vegetation } from "./world/Vegetation";
import { Water } from "./world/Water";
import { Atmosphere } from "./world/Atmosphere";
import { PixelSwarm } from "./world/PixelSwarm";
import { Totem } from "./world/Totem";
import { BloomComposer } from "./postfx/BloomComposer";
import { WorldNet } from "./net/WorldNet";
import type { BiospherePreset } from "./planet/types";

/**
 * PaqoWorld — escena jugable de la Biósfera Paqo, ahora sobre una ISLA FLOTANTE.
 * Orquesta isla (heightmap) + controller planar + cámara de seguimiento + input
 * triple. No importa nada de React/Next: la app sólo instancia, llama start() y
 * dispose(). El contrato de la página /b/paqo no cambia.
 */
export class PaqoWorld {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  // Públicos para el harness de QA (handle __PAQO__): métricas de caminata.
  island!: Island;
  controller!: CharacterController;

  /** Hooks de multijugador (avatares remotos, pelotas, zonas). Disponible tras start(). */
  net!: WorldNet;

  private rig!: TestDummy;
  private follow!: FollowCamera;
  private input!: InputManager;

  private rune!: THREE.Mesh;
  private pixels!: PixelSwarm;
  private marker!: THREE.Mesh;
  private moveTarget: THREE.Vector3 | null = null;
  private markerLife = 0;

  private vegetation!: Vegetation;
  private water!: Water;
  private atmosphere!: Atmosphere;
  private totem!: Totem;
  private bloom!: BloomComposer;

  // Fundido de caída al vacío → respawn contemplativo.
  private fade!: HTMLDivElement;
  private fadePhase: "none" | "in" | "out" = "none";
  private fadeAmt = 0;

  private rafId = 0;
  private disposed = false;
  private resizeObs?: ResizeObserver;
  private lastW = 0;
  private lastH = 0;

  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _worldDir = new THREE.Vector3();
  private _ray = new THREE.Raycaster();
  private _ndc = new THREE.Vector2();
  private _pointerNdc = new THREE.Vector2();
  private _pointerWorld = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  /** Spawn a ~7 u del tótem (origen), mirándolo; laderas del anfiteatro de fondo. */
  private spawnPos = new THREE.Vector3(0, 0, 7);

  constructor(
    private container: HTMLElement,
    private preset: BiospherePreset,
    private onReady?: () => void,
  ) {}

  start(): void {
    (globalThis as { __PAQO__?: PaqoWorld }).__PAQO__ = this;
    this.initRenderer();
    this.initScene();

    this.island = new Island(this.preset);
    this.island.addTo(this.scene);

    this.buildRune();
    this.buildMarker();
    this.buildFade();

    this.vegetation = new Vegetation(this.island.field, this.preset, this.spawnPos);
    this.vegetation.build();
    this.vegetation.addTo(this.scene);

    this.water = new Water(this.island.field, this.preset);
    this.water.build();
    this.water.addTo(this.scene);

    this.atmosphere = new Atmosphere(this.island.field, this.preset);
    this.atmosphere.build();
    this.atmosphere.addTo(this.scene);

    // Enjambre de píxeles interactivos (oro/rosa/lila) — reemplaza bruma/esporas.
    this.pixels = new PixelSwarm(this.island.field, this.preset);
    this.pixels.addTo(this.scene);

    this.rig = new TestDummy();
    this.controller = new CharacterController(this.island, this.spawnPos, this.rig);
    this.controller.onVoidFall = () => this.beginFall();
    this.controller.addTo(this.scene);
    this.controller.faceToward(this.rune.position);

    this.follow = new FollowCamera(this.camera, this.controller);
    this.follow.snapBehind();

    this.input = new InputManager(this.container);
    this.input.onTap = (x, y) => this.handleTap(x, y);
    this.input.onManualMove = () => this.clearMoveTarget();

    // Hooks de multijugador (avatares remotos + 9 pelotas + señales de zona).
    // No hablan con la red: la red (apps/web) programa contra `world.net`.
    this.net = new WorldNet({
      scene: this.scene,
      camera: this.camera,
      playerPosition: this.controller.position,
      playerForward: (out) => this.controller.getForward(out),
      playerGrounded: () => this.controller.isGrounded(),
      playerFeetY: () => this.controller.feetY,
      field: this.island.field,
    });
    this.net.start();

    this.bloom = new BloomComposer(
      this.renderer,
      this.scene,
      this.camera,
      this.preset.postFx?.bloom ?? 0.3,
    );
    this.bloom.addSelection(this.rune);
    const { w, h } = this.size();
    this.bloom.setSize(w, h);

    this.renderer.compile(this.scene, this.camera);
    this.loop();

    this.totem = new Totem(this.island.field);
    this.totem
      .load(this.scene)
      .catch(() => undefined)
      .finally(() => {
        if (!this.disposed) this.renderer.compile(this.scene, this.camera);
        this.onReady?.();
      });
  }

  /** Error de anclaje al suelo (m): |pies − heightAt|. Para la métrica de QA. */
  groundError(): number {
    return this.controller.groundError();
  }

  private size(): { w: number; h: number } {
    return {
      w: this.container.clientWidth || window.innerWidth,
      h: this.container.clientHeight || window.innerHeight,
    };
  }

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const { w, h } = this.size();
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.container.appendChild(this.renderer.domElement);
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    window.addEventListener("resize", this.onResize);
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.preset.sky.gradientTop);
    // Niebla exp2: horizonte fundido, abismo brumoso al mirar lejos/abajo.
    this.scene.fog = new THREE.FogExp2(new THREE.Color(this.preset.fog.color).getHex(), 0.0085);

    this.camera = new THREE.PerspectiveCamera(
      50,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      2000,
    );

    // Cúpula de cielo (gradiente vertical del preset).
    const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(this.preset.sky.gradientTop) },
        bottom: { value: new THREE.Color(this.preset.sky.gradientBottom) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
        void main() {
          float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottom, top, h), 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Luz key ÁMBAR dorada cálida; rebote de cielo cálido y rebote de suelo MORADO
    // (HemisphereLight) → sombras que viran a malva sin pass extra. Preset-driven.
    const lg = this.preset.lighting ?? {};
    const key = new THREE.DirectionalLight(new THREE.Color(lg.keyColor ?? "#FFCF8A"), lg.keyIntensity ?? 1.05);
    key.position.set(80, 120, 60);
    this.scene.add(key);
    // Intensidad contenida (0.78) y rebote apenas enfriado para que el atardecer
    // bañe el valle SIN lavar el alma verde del terreno.
    this.scene.add(
      new THREE.HemisphereLight(
        new THREE.Color(lg.skyBounceColor ?? "#EFC5BC"),
        new THREE.Color(lg.ambientColor ?? "#433A6B"),
        lg.ambientIntensity ?? 0.78,
      ),
    );
  }

  /** Anillo-runa emisivo dorado en el suelo del claro (origen), plano. */
  private buildRune(): void {
    const p = this.island.field.surfacePoint(0, 0);
    const geo = new THREE.TorusGeometry(3.6, 0.26, 10, 48);
    const mat = new THREE.MeshToonMaterial({
      color: 0x3a2f18,
      emissive: new THREE.Color(0xe3b063),
      emissiveIntensity: 0.6,
      gradientMap: makeToonRamp(),
    });
    this.rune = new THREE.Mesh(geo, mat);
    this.rune.position.copy(p).add(new THREE.Vector3(0, 0.4, 0));
    this.rune.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), PaqoWorld.UP);
    this.scene.add(this.rune);
  }

  private buildMarker(): void {
    const geo = new THREE.TorusGeometry(0.9, 0.12, 8, 28);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe3b063, transparent: true, opacity: 0, fog: false });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  private buildFade(): void {
    this.fade = document.createElement("div");
    Object.assign(this.fade.style, {
      position: "absolute",
      inset: "0",
      background: this.preset.fog.color,
      opacity: "0",
      pointerEvents: "none",
      zIndex: "4",
      transition: "none",
    } as CSSStyleDeclaration);
    if (getComputedStyle(this.container).position === "static") this.container.style.position = "relative";
    this.container.appendChild(this.fade);
  }

  private beginFall(): void {
    if (this.fadePhase === "none") this.fadePhase = "in";
  }

  // ---- tap-to-move ----

  private handleTap(ndcX: number, ndcY: number): void {
    this._ndc.set(ndcX, ndcY);
    this._ray.setFromCamera(this._ndc, this.camera);
    const hit = this.island.raycastFrom(this._ray);
    if (!hit) return;
    this.moveTarget = hit.point.clone();
    this.marker.position.copy(hit.point).addScaledVector(hit.normal, 0.1);
    this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    this.marker.visible = true;
    this.markerLife = 1;
    (this.marker.material as THREE.MeshBasicMaterial).opacity = 0.9;
  }

  private clearMoveTarget(): void {
    this.moveTarget = null;
  }

  /**
   * Proyecta un NDC del puntero a un punto 3D en el área de juego: rayo de cámara
   * a la distancia cámara→avatar (acotada) → el campo magnético queda alrededor
   * de donde el jugador está mirando, sin necesitar raycast contra el terreno.
   */
  private projectPointer(ndc: THREE.Vector2): THREE.Vector3 {
    this._ray.setFromCamera(ndc, this.camera);
    const d = THREE.MathUtils.clamp(
      this.camera.position.distanceTo(this.controller.position),
      10,
      120,
    );
    return this._pointerWorld.copy(this._ray.ray.origin).addScaledVector(this._ray.ray.direction, d);
  }

  private onResize = (): void => {
    if (this.disposed) return;
    const { w, h } = this.size();
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.bloom?.setSize(w, h);
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    const { w: cw, h: ch } = this.size();
    if (cw !== this.lastW || ch !== this.lastH) {
      this.lastW = cw;
      this.lastH = ch;
      this.onResize();
    }

    const o = this.input.consumeOrbit();
    if (o.dx || o.dy) this.follow.orbit(o.dx, o.dy);
    const z = this.input.consumeZoom();
    if (z) this.follow.zoom(z);

    const f = this.input.consumeMove();
    let throttle = 0;
    this._worldDir.set(0, 0, 0);

    if (this.moveTarget) {
      this._worldDir.copy(this.moveTarget).sub(this.controller.position);
      this._worldDir.y = 0;
      const dist = this._worldDir.length();
      if (dist < 1.3) {
        this.clearMoveTarget();
      } else {
        this._worldDir.normalize();
        throttle = 1;
      }
    } else if (f.moveAxis.lengthSq() > 0.001) {
      this.camera.getWorldDirection(this._fwd);
      this._fwd.y = 0;
      if (this._fwd.lengthSq() < 1e-5) this._fwd.set(0, 0, -1);
      this._fwd.normalize();
      this._right.crossVectors(this._fwd, PaqoWorld.UP).normalize();
      this._worldDir
        .addScaledVector(this._fwd, f.moveAxis.y)
        .addScaledVector(this._right, f.moveAxis.x);
      throttle = Math.min(1, f.moveAxis.length());
    }

    this.controller.update(dt, { worldDir: this._worldDir, throttle, run: f.run, jump: f.jump });
    this.follow.update(dt);

    // Multijugador: interpola remotos, integra pelotas, evalúa zonas.
    this.net.update(dt);

    this.updateFade(dt);

    const runeMat = this.rune.material as THREE.MeshToonMaterial;
    runeMat.emissiveIntensity = 0.55 + Math.sin(t * 1.6) * 0.18;

    // Campo magnético del puntero: proyecta el cursor/dedo a un punto 3D del área
    // de juego (a la distancia cámara→avatar) y alimenta el enjambre de píxeles.
    const pointer = this.input.readPointer(this._pointerNdc)
      ? this.projectPointer(this._pointerNdc)
      : null;
    this.pixels.update(dt, t, pointer);

    this.vegetation.update(dt, t);
    this.water.update(dt, t);
    this.atmosphere.update(dt, t);

    if (this.marker.visible) {
      const pulse = 1 + Math.sin(t * 6) * 0.12;
      const mMat = this.marker.material as THREE.MeshBasicMaterial;
      if (!this.moveTarget) {
        this.markerLife -= dt * 2.2;
        mMat.opacity = Math.max(0, this.markerLife) * 0.9;
        if (this.markerLife <= 0) this.marker.visible = false;
      }
      this.marker.scale.setScalar(pulse);
    }

    this.bloom.render(dt);
  };

  /** Máquina de fundido: entra a niebla al caer, respawnea, sale del fundido. */
  private updateFade(dt: number): void {
    if (this.fadePhase === "in") {
      this.fadeAmt = Math.min(1, this.fadeAmt + dt / 0.5);
      if (this.fadeAmt >= 1) {
        this.controller.respawn();
        this.follow.snapBehind();
        this.clearMoveTarget();
        this.fadePhase = "out";
      }
    } else if (this.fadePhase === "out") {
      this.fadeAmt = Math.max(0, this.fadeAmt - dt / 0.6);
      if (this.fadeAmt <= 0) this.fadePhase = "none";
    }
    this.fade.style.opacity = String(this.fadeAmt);
  }

  dispose(): void {
    this.disposed = true;
    const g = globalThis as { __PAQO__?: PaqoWorld };
    if (g.__PAQO__ === this) delete g.__PAQO__;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.net?.dispose();
    this.input?.dispose();
    this.controller?.dispose();
    this.rig?.dispose();
    this.vegetation?.dispose();
    this.water?.dispose();
    this.atmosphere?.dispose();
    this.pixels?.dispose();
    this.totem?.dispose();
    this.bloom?.dispose();
    this.island?.dispose();
    this.fade?.remove();
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
