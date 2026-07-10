import * as THREE from "three";
import { SimplexNoise } from "./noise";

/**
 * Subconjunto del preset de biósfera que consume el "hola planeta".
 * (El preset completo vive en @phygitalia/content/biospheres/paqo.json.)
 */
export interface PlanetPreset {
  palette: { primary: string; secondary: string; accent: string; ground: string; sky: string };
  terrain: { heightNoise: { amplitude: number; frequency: number; octaves: number } };
  sky: { gradientTop: string; gradientBottom: string };
  fog: { color: string };
  postFx: { outline: { color: string } };
}

interface OrbitState {
  theta: number; // azimut
  phi: number; // polar
  radius: number;
  targetTheta: number;
  targetPhi: number;
  targetRadius: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
  pinchDist: number;
}

/**
 * "Hola planeta" — mini-planeta cel-shading low-poly con la paleta Paqo.
 * Toda la lógica three vive aquí (separación engine/app del plan maestro);
 * la app sólo instancia, llama a start() y a dispose().
 */
export class HolaPlaneta {
  private container: HTMLElement;
  private preset: PlanetPreset;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private planet!: THREE.Mesh;
  private outline!: THREE.Mesh;
  private rune!: THREE.Mesh;
  private mist!: THREE.Points;

  private orbit: OrbitState;
  private rafId = 0;
  private disposed = false;
  private onReady?: () => void;

  // Radio base del planeta en unidades de mundo.
  private static readonly RADIUS = 40;

  constructor(container: HTMLElement, preset: PlanetPreset, onReady?: () => void) {
    this.container = container;
    this.preset = preset;
    this.onReady = onReady;
    this.orbit = {
      theta: 0.6,
      phi: Math.PI / 2.35,
      radius: HolaPlaneta.RADIUS * 2.6,
      targetTheta: 0.6,
      targetPhi: Math.PI / 2.35,
      targetRadius: HolaPlaneta.RADIUS * 2.6,
      dragging: false,
      lastX: 0,
      lastY: 0,
      pinchDist: 0,
    };
  }

  start(): void {
    this.initRenderer();
    this.initScene();
    this.buildPlanet();
    this.buildRune();
    this.buildMist();
    this.bindEvents();
    // Un frame de "calentamiento" para compilar shaders antes de avisar listo.
    this.renderer.compile(this.scene, this.camera);
    this.onReady?.();
    this.loop();
  }

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    this.container.appendChild(this.renderer.domElement);
  }

  private initScene(): void {
    this.scene = new THREE.Scene();

    const sky = new THREE.Color(this.preset.sky.gradientTop);
    // Fondo = cielo lechoso; la niebla exp2 casa con él para fundir horizonte.
    this.scene.background = sky.clone();
    this.scene.fog = new THREE.FogExp2(new THREE.Color(this.preset.fog.color).getHex(), 0.0075);

    this.camera = new THREE.PerspectiveCamera(
      45,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      2000,
    );

    // Cúpula de cielo: gran esfera invertida con gradiente vertical del preset.
    const skyGeo = new THREE.SphereGeometry(900, 32, 16);
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
        uniform vec3 top;
        uniform vec3 bottom;
        varying vec3 vPos;
        void main() {
          float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottom, top, h), 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Luz clave cálida difusa + hemisférica para que la niebla no ennegrezca.
    const key = new THREE.DirectionalLight(0xf6dca0, 1.1);
    key.position.set(60, 80, 40);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xe8ecea, 0x3b4a3f, 0.9));
  }

  /** Rampa toon de 3 bandas como DataTexture (gris) para gradientMap. */
  private makeToonRamp(): THREE.DataTexture {
    const data = new Uint8Array([70, 70, 70, 255, 160, 160, 160, 255, 255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  private buildPlanet(): void {
    const { amplitude, frequency, octaves } = this.preset.terrain.heightNoise;
    const noise = new SimplexNoise(20260710);

    const geo = new THREE.IcosahedronGeometry(HolaPlaneta.RADIUS, 6);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const colorGround = new THREE.Color(this.preset.palette.ground);
    const colorMeadow = new THREE.Color(this.preset.palette.accent);
    const colors = new Float32Array(pos.count * 3);

    // El preset trae amplitude/frequency en unidades de terreno plano gigante;
    // se reescala a la esfera pequeña del hola-planeta.
    const amp = (amplitude / 42) * 6.0;
    const freq = frequency * 130;
    // "Claro/pradera" centrado en el polo +Y (punto de encuentro del plan).
    const clearDir = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = v.clone().normalize();
      // fBm sobre la dirección normalizada → relieve continuo sin costuras.
      let h = noise.fbm(n.x * freq, n.y * freq, n.z * freq, octaves, 0.5, 2) * amp;

      // Aplanar el claro central (flatness alto en el preset).
      const clearing = Math.max(0, n.dot(clearDir));
      const flat = Math.pow(clearing, 6);
      h *= 1 - flat * 0.85;

      const r = HolaPlaneta.RADIUS + h;
      pos.setXYZ(i, n.x * r, n.y * r, n.z * r);

      // Color por altura + parche de pradera ácida en el claro.
      const t = THREE.MathUtils.clamp((h + amp) / (amp * 2), 0, 1);
      const c = colorGround.clone().lerp(new THREE.Color(this.preset.palette.primary), 1 - t);
      c.lerp(colorMeadow, flat * 0.8);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: this.makeToonRamp(),
    });
    this.planet = new THREE.Mesh(geo, mat);
    this.scene.add(this.planet);

    // Outline tinta por inverted-hull: clon a BackSide, escalado ligeramente.
    const outlineMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.preset.postFx.outline.color),
      side: THREE.BackSide,
      fog: false,
    });
    this.outline = new THREE.Mesh(geo, outlineMat);
    this.outline.scale.setScalar(1.02);
    this.planet.add(this.outline);
  }

  /** Marcador-runa emisivo dorado en el claro (polo +Y). */
  private buildRune(): void {
    const geo = new THREE.TorusGeometry(6, 0.9, 12, 48);
    const mat = new THREE.MeshToonMaterial({
      color: 0x3a2f18,
      emissive: new THREE.Color(0xe3b063),
      emissiveIntensity: 1.4,
      gradientMap: this.makeToonRamp(),
    });
    this.rune = new THREE.Mesh(geo, mat);
    // Posado plano sobre el claro, apenas por encima de la superficie.
    this.rune.position.set(0, HolaPlaneta.RADIUS + 0.6, 0);
    this.rune.rotation.x = Math.PI / 2;
    this.planet.add(this.rune);
  }

  /** Textura circular suave generada en canvas 2D para las motas de bruma. */
  private makeSpriteTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.4, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  private buildMist(): void {
    const count = 200;
    const positions = new Float32Array(count * 3);
    const R = HolaPlaneta.RADIUS;
    for (let i = 0; i < count; i++) {
      // Distribución en cáscara esférica alrededor del planeta.
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
      ).normalize();
      const r = R + 4 + Math.random() * R * 0.9;
      positions[i * 3] = dir.x * r;
      positions[i * 3 + 1] = dir.y * r;
      positions[i * 3 + 2] = dir.z * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 3.2,
      map: this.makeSpriteTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.mist = new THREE.Points(geo, mat);
    this.scene.add(this.mist);
  }

  // ---- Input: OrbitControls mínimo propio (mouse + touch), sin dependencias ----

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("resize", this.onResize);
  }

  private activePointers = new Map<number, { x: number; y: number }>();

  private onPointerDown = (e: PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.orbit.dragging = true;
    this.orbit.lastX = e.clientX;
    this.orbit.lastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size >= 2) {
      // Pinch-zoom táctil.
      const pts = [...this.activePointers.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.orbit.pinchDist > 0) {
        const delta = this.orbit.pinchDist - d;
        this.orbit.targetRadius = THREE.MathUtils.clamp(
          this.orbit.targetRadius + delta * 0.35,
          HolaPlaneta.RADIUS * 1.35,
          HolaPlaneta.RADIUS * 4.5,
        );
      }
      this.orbit.pinchDist = d;
      return;
    }

    if (!this.orbit.dragging) return;
    const dx = e.clientX - this.orbit.lastX;
    const dy = e.clientY - this.orbit.lastY;
    this.orbit.lastX = e.clientX;
    this.orbit.lastY = e.clientY;
    this.orbit.targetTheta -= dx * 0.006;
    this.orbit.targetPhi = THREE.MathUtils.clamp(
      this.orbit.targetPhi - dy * 0.006,
      0.25,
      Math.PI - 0.25,
    );
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.orbit.pinchDist = 0;
    if (this.activePointers.size === 0) this.orbit.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.orbit.targetRadius = THREE.MathUtils.clamp(
      this.orbit.targetRadius + e.deltaY * 0.05,
      HolaPlaneta.RADIUS * 1.35,
      HolaPlaneta.RADIUS * 4.5,
    );
  };

  private onResize = (): void => {
    if (this.disposed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;

    // Damping de cámara hacia el objetivo.
    const damp = 1 - Math.pow(0.0015, dt);
    this.orbit.theta += (this.orbit.targetTheta - this.orbit.theta) * damp;
    this.orbit.phi += (this.orbit.targetPhi - this.orbit.phi) * damp;
    this.orbit.radius += (this.orbit.targetRadius - this.orbit.radius) * damp;

    const sinPhi = Math.sin(this.orbit.phi);
    this.camera.position.set(
      this.orbit.radius * sinPhi * Math.sin(this.orbit.theta),
      this.orbit.radius * Math.cos(this.orbit.phi),
      this.orbit.radius * sinPhi * Math.cos(this.orbit.theta),
    );
    this.camera.lookAt(0, 0, 0);

    // Rotación automática lentísima del planeta (y su outline/runa hijos).
    this.planet.rotation.y += dt * 0.04;

    // Pulso senoidal de la runa emisiva.
    const runeMat = this.rune.material as THREE.MeshToonMaterial;
    runeMat.emissiveIntensity = 1.1 + Math.sin(t * 1.6) * 0.5;

    // Deriva lenta de la bruma.
    this.mist.rotation.y -= dt * 0.012;
    this.mist.rotation.x += dt * 0.004;

    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    const el = this.renderer?.domElement;
    if (el) {
      el.removeEventListener("pointerdown", this.onPointerDown);
      el.removeEventListener("pointermove", this.onPointerMove);
      el.removeEventListener("pointerup", this.onPointerUp);
      el.removeEventListener("pointercancel", this.onPointerUp);
      el.removeEventListener("wheel", this.onWheel);
    }
    window.removeEventListener("resize", this.onResize);
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.renderer?.dispose();
    if (el && el.parentElement) el.parentElement.removeChild(el);
  }
}
