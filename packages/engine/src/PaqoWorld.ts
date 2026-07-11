import * as THREE from "three";
import { Planet } from "./planet/Planet";
import { CharacterController } from "./controller/CharacterController";
import { TestDummy } from "./avatar/TestDummy";
import { FollowCamera } from "./camera/FollowCamera";
import { InputManager } from "./input/InputManager";
import { makeToonRamp, makeSoftCircleTexture } from "./util/toon";
import { Vegetation } from "./world/Vegetation";
import { Water } from "./world/Water";
import { Atmosphere } from "./world/Atmosphere";
import { Totem } from "./world/Totem";
import { BloomComposer } from "./postfx/BloomComposer";
import type { BiospherePreset } from "./planet/types";

/**
 * PaqoWorld — escena jugable de la Biósfera Paqo.
 * Orquesta planeta + controller esférico + cámara de seguimiento + input triple.
 * No importa nada de React/Next: la app sólo instancia, llama start() y dispose().
 */
export class PaqoWorld {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private planet!: Planet;
  private controller!: CharacterController;
  private rig!: TestDummy;
  private follow!: FollowCamera;
  private input!: InputManager;

  private rune!: THREE.Mesh;
  private mist!: THREE.Points;
  private marker!: THREE.Mesh; // destino de tap-to-move
  private moveTarget: THREE.Vector3 | null = null;
  private markerLife = 0;

  // Biósfera: vegetación, agua, atmósfera, tótem y bloom selectivo.
  private vegetation!: Vegetation;
  private water!: Water;
  private atmosphere!: Atmosphere;
  private totem!: Totem;
  private bloom!: BloomComposer;

  private rafId = 0;
  private disposed = false;
  private resizeObs?: ResizeObserver;
  private lastW = 0;
  private lastH = 0;

  // Reutilizables por frame.
  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _worldDir = new THREE.Vector3();
  private _ray = new THREE.Raycaster();
  private _ndc = new THREE.Vector2();

  private spawnDir = new THREE.Vector3(0, 1, 0.18).normalize();

  constructor(
    private container: HTMLElement,
    private preset: BiospherePreset,
    private onReady?: () => void,
  ) {}

  start(): void {
    // Handle de depuración para QA/harness (consola: __PAQO__). Coste cero;
    // se limpia en dispose().
    (globalThis as { __PAQO__?: PaqoWorld }).__PAQO__ = this;
    this.initRenderer();
    this.initScene();

    this.planet = new Planet(this.preset);
    this.planet.addTo(this.scene);

    this.buildRune();
    this.buildMist();
    this.buildMarker();

    // --- Biósfera: vegetación instanciada, agua, atmósfera ---
    this.vegetation = new Vegetation(this.planet.field, this.preset, this.spawnDir);
    this.vegetation.build();
    this.vegetation.addTo(this.scene);

    this.water = new Water(this.planet.field, this.preset);
    this.water.build();
    this.water.addTo(this.scene);

    this.atmosphere = new Atmosphere(this.planet.field, this.preset);
    this.atmosphere.build();
    this.atmosphere.addTo(this.scene);

    // Avatar: maniquí chibi procedural (TestDummy) hasta que lleguen los GLB
    // de Tripo3D — mismo contrato IAvatarRig, cambio de una línea después.
    this.rig = new TestDummy();
    this.controller = new CharacterController(this.planet, this.spawnDir, this.rig);
    this.controller.addTo(this.scene);
    // Mirar hacia la runa (polo +Y) para el encuadre inicial bonito.
    this.controller.faceToward(this.rune.position);

    this.follow = new FollowCamera(this.camera, this.controller);
    this.follow.snapBehind();

    this.input = new InputManager(this.container);
    this.input.onTap = (x, y) => this.handleTap(x, y);
    this.input.onManualMove = () => this.clearMoveTarget();

    // --- Bloom selectivo: sólo el anillo-runa emisivo (degradable en móvil) ---
    this.bloom = new BloomComposer(
      this.renderer,
      this.scene,
      this.camera,
      this.preset.postFx?.bloom ?? 0.3,
    );
    this.bloom.addSelection(this.rune);
    const { w, h } = this.size();
    this.bloom.setSize(w, h);

    // Calentamiento de shaders antes de avisar "listo".
    this.renderer.compile(this.scene, this.camera);
    this.loop();

    // Tótem de Paqo: se carga async (GLB draco+webp). El valle ya es jugable;
    // cuando aterriza, se avisa "listo" para el money-shot completo.
    this.totem = new Totem(this.planet.field);
    this.totem
      .load(this.scene)
      .catch(() => undefined)
      .finally(() => {
        if (!this.disposed) this.renderer.compile(this.scene, this.camera);
        this.onReady?.();
      });
  }

  /** Tamaño del contenedor con fallback a la ventana (evita canvas 0×0 en el 1er frame). */
  private size(): { w: number; h: number } {
    return {
      w: this.container.clientWidth || window.innerWidth,
      h: this.container.clientHeight || window.innerHeight,
    };
  }

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const { w, h } = this.size();
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.container.appendChild(this.renderer.domElement);
    // ResizeObserver: capta cuando el contenedor obtiene su tamaño real tras el
    // montaje (el listener de window no basta si es el contenedor quien cambia).
    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    window.addEventListener("resize", this.onResize);
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.preset.sky.gradientTop);
    // Niebla exp2: horizonte fundido, primer plano nítido (Paqo brumoso).
    this.scene.fog = new THREE.FogExp2(new THREE.Color(this.preset.fog.color).getHex(), 0.011);

    this.camera = new THREE.PerspectiveCamera(
      50,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      2000,
    );

    // Cúpula de cielo (gran esfera invertida, gradiente vertical del preset).
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
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
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

    // Luz clave difusa cálida + hemisférica (la niebla no ennegrece).
    const key = new THREE.DirectionalLight(0xf6dca0, 1.05);
    key.position.set(80, 120, 60);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xe8ecea, 0x3b4a3f, 0.95));
  }

  /** Anillo-runa emisivo dorado en el suelo, rodeando la base del tótem (polo +Y). */
  private buildRune(): void {
    const dir = new THREE.Vector3(0, 1, 0);
    const p = this.planet.field.surfacePoint(dir);
    // Delgado y contenido: el glifo ACOMPAÑA al tótem, no le compite.
    const geo = new THREE.TorusGeometry(3.6, 0.26, 10, 48);
    const mat = new THREE.MeshToonMaterial({
      color: 0x3a2f18,
      emissive: new THREE.Color(0xe3b063),
      emissiveIntensity: 0.6,
      gradientMap: makeToonRamp(),
    });
    this.rune = new THREE.Mesh(geo, mat);
    this.rune.position.copy(p).addScaledVector(dir, 0.4);
    this.rune.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.scene.add(this.rune);
  }

  private buildMist(): void {
    const count = 240;
    const positions = new Float32Array(count * 3);
    const R = this.planet.field.radius;
    for (let i = 0; i < count; i++) {
      const d = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      ).normalize();
      const r = R + 3 + Math.random() * R * 0.8;
      positions[i * 3] = d.x * r;
      positions[i * 3 + 1] = d.y * r;
      positions[i * 3 + 2] = d.z * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 3.0,
      map: makeSoftCircleTexture("rgba(255,255,255,0.85)"),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.mist = new THREE.Points(geo, mat);
    this.scene.add(this.mist);
  }

  /** Marcador dorado pulsante del destino de tap-to-move. */
  private buildMarker(): void {
    const geo = new THREE.TorusGeometry(0.9, 0.12, 8, 28);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe3b063,
      transparent: true,
      opacity: 0,
      fog: false,
    });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  // ---- tap-to-move ----

  private handleTap(ndcX: number, ndcY: number): void {
    this._ndc.set(ndcX, ndcY);
    this._ray.setFromCamera(this._ndc, this.camera);
    const hit = this.planet.raycastFrom(this._ray);
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
    const dt = Math.min(this.clock.getDelta(), 0.05); // clamp anti-salto tras pausa
    const t = this.clock.elapsedTime;

    // Cinturón de seguridad: si el contenedor cambió de tamaño y ni el evento
    // resize ni el ResizeObserver lo captaron (entornos embebidos que
    // throttlean el pipeline de render), corrígelo aquí. Dos lecturas baratas.
    const { w: cw, h: ch } = this.size();
    if (cw !== this.lastW || ch !== this.lastH) {
      this.lastW = cw;
      this.lastH = ch;
      this.onResize();
    }

    // --- Input de cámara (orbit/zoom) ---
    const o = this.input.consumeOrbit();
    if (o.dx || o.dy) this.follow.orbit(o.dx, o.dy);
    const z = this.input.consumeZoom();
    if (z) this.follow.zoom(z);

    // --- Intención de movimiento ---
    const f = this.input.consumeMove();
    const up = this.controller.position.clone().normalize();
    let throttle = 0;
    this._worldDir.set(0, 0, 0);

    if (this.moveTarget) {
      // Steering hacia el destino de tap-to-move.
      this._worldDir.copy(this.moveTarget).sub(this.controller.position);
      this._worldDir.addScaledVector(up, -this._worldDir.dot(up));
      const dist = this._worldDir.length();
      if (dist < 1.3) {
        this.clearMoveTarget();
      } else {
        this._worldDir.normalize();
        throttle = 1;
      }
    } else if (f.moveAxis.lengthSq() > 0.001) {
      // Movimiento relativo a cámara proyectado al plano tangente.
      this.camera.getWorldDirection(this._fwd);
      this._fwd.addScaledVector(up, -this._fwd.dot(up));
      if (this._fwd.lengthSq() < 1e-5) this._fwd.set(1, 0, 0);
      this._fwd.normalize();
      this._right.crossVectors(this._fwd, up).normalize();
      this._worldDir
        .addScaledVector(this._fwd, f.moveAxis.y)
        .addScaledVector(this._right, f.moveAxis.x);
      throttle = Math.min(1, f.moveAxis.length());
    }

    this.controller.update(dt, {
      worldDir: this._worldDir,
      throttle,
      run: f.run,
      jump: f.jump,
    });

    this.follow.update(dt);

    // --- Animaciones de ambiente ---
    const runeMat = this.rune.material as THREE.MeshToonMaterial;
    runeMat.emissiveIntensity = 0.55 + Math.sin(t * 1.6) * 0.18; // pulso sutil, místico

    this.mist.rotation.y -= dt * 0.01;

    // Vegetación (viento), agua (espuma) y atmósfera (niebla rodante + polen).
    this.vegetation.update(dt, t);
    this.water.update(dt, t);
    this.atmosphere.update(dt, t);

    // Marcador: pulso + desvanecido al llegar.
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

    // Render con bloom selectivo (o directo si degradado en móvil débil).
    this.bloom.render(dt);
  };

  dispose(): void {
    this.disposed = true;
    const g = globalThis as { __PAQO__?: PaqoWorld };
    if (g.__PAQO__ === this) delete g.__PAQO__;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.input?.dispose();
    this.controller?.dispose(); // desengancha el rig sin liberarlo…
    this.rig?.dispose(); // …aquí se liberan sus geometrías/clips (dueño: el mundo)
    this.vegetation?.dispose();
    this.water?.dispose();
    this.atmosphere?.dispose();
    this.totem?.dispose();
    this.bloom?.dispose();
    this.planet?.dispose();
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
