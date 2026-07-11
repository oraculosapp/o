/**
 * splash-scene.ts — Diorama ceremonial del Splash de o.oraculos.app.
 *
 * Autocontenido a propósito (NO importa de @phygitalia/engine; otro equipo lo
 * está reestructurando). Un círculo de 6 estatuas chibi alrededor de una runa
 * dorada emisiva, flotando en la nebulosa (la nebulosa la pinta el CSS de fondo;
 * este canvas es transparente y solo compone figuras + oro + polvo estelar).
 *
 * Barato por diseño: sin bloom/postproceso. El resplandor sale de sprites y
 * planos con blending aditivo y de MeshToonMaterial con luz de recorte dorada.
 *
 * Carga progresiva: la escena arranca al instante con la runa y el polvo; cada
 * chibi entra en fade cuando su GLB (EXT_meshopt_compression) termina de cargar.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const GOLD = 0xe3b063;
const GOLD_BRIGHT = 0xf6dca0;

/** Los 6 chibis del círculo (assets/splash/*.glb). Orden = posición en el aro. */
const CHIBIS = ["mage", "shaman", "purple", "painter", "dwarf", "hacker"] as const;

const RING_RADIUS = 2.55;
const CHIBI_HEIGHT = 1.18; // altura objetivo en unidades de escena (vienen a 2.0)

/** Rampa toon de 3 bandas para el cel-shading (gris → se multiplica por el map). */
function makeToonRamp(): THREE.DataTexture {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Sprite circular suave (para el polvo estelar y el halo de la runa). */
function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(246,220,160,0.55)");
  g.addColorStop(1, "rgba(246,220,160,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Runa ceremonial dibujada a mano en canvas (transparente + oro), inspirada en
 * assets/runa.png: círculos concéntricos, marcas radiales y un sigilo central
 * (chevron arriba, ojo, chevron abajo, media luna y barras). Se usa como plano
 * emisivo aditivo en el suelo.
 */
function makeRuneTexture(): THREE.CanvasTexture {
  const S = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const c = S / 2;
  ctx.translate(c, c);
  ctx.strokeStyle = "rgba(246,220,160,0.92)";
  ctx.fillStyle = "rgba(246,220,160,0.92)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(227,176,99,0.9)";
  ctx.shadowBlur = 14;

  // Círculos concéntricos.
  const rings = [S * 0.46, S * 0.38, S * 0.3];
  rings.forEach((r, i) => {
    ctx.lineWidth = i === 0 ? 3 : 2;
    ctx.globalAlpha = i === 0 ? 0.5 : 0.7;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Marcas radiales (24 ticks) sobre el segundo anillo.
  const rTick = S * 0.38;
  ctx.lineWidth = 2;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const inner = i % 3 === 0 ? rTick - 26 : rTick - 13;
    ctx.globalAlpha = i % 3 === 0 ? 0.85 : 0.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * (rTick + 6), Math.sin(a) * (rTick + 6));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Sigilo central (vertical), escala en px.
  const u = S * 0.052;
  ctx.lineWidth = 4;
  // chevron superior
  ctx.beginPath();
  ctx.moveTo(-u, -u * 2.2);
  ctx.lineTo(0, -u * 3.4);
  ctx.lineTo(u, -u * 2.2);
  ctx.stroke();
  // ojo (círculo con punto)
  ctx.beginPath();
  ctx.arc(0, -u * 0.9, u * 0.85, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -u * 0.9, u * 0.16, 0, Math.PI * 2);
  ctx.fill();
  // casa/chevron inferior con hombros
  ctx.beginPath();
  ctx.moveTo(-u * 0.9, u * 1.9);
  ctx.lineTo(-u * 0.9, u * 0.9);
  ctx.lineTo(0, u * 0.2);
  ctx.lineTo(u * 0.9, u * 0.9);
  ctx.lineTo(u * 0.9, u * 1.9);
  ctx.stroke();
  // media luna bajo la casa
  ctx.beginPath();
  ctx.arc(0, u * 1.7, u * 1.15, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  // barras horizontales (báculo)
  for (let i = 0; i < 3; i++) {
    const y = u * (2.7 + i * 0.42);
    const w = u * (1.05 - i * 0.22);
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Guarda referencia para el fade-in de cada chibi. */
interface ChibiEntry {
  root: THREE.Object3D;
  materials: THREE.MeshToonMaterial[];
  bornAt: number; // segundos de reloj al añadirse
  baseY: number; // fase de respiración
}

export class SplashScene {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private stage!: THREE.Group; // se inclina con el parallax + respira
  private ring!: THREE.Group; // gira lento como constelación
  private rune!: THREE.Mesh;
  private runeHalo!: THREE.Sprite;
  private dust!: THREE.Points;

  private chibis: ChibiEntry[] = [];
  private ramp = makeToonRamp();

  private rafId = 0;
  private disposed = false;
  private resizeObs?: ResizeObserver;

  private reduced = false;
  private pointer = new THREE.Vector2(0, 0); // objetivo del parallax
  private pointerLerp = new THREE.Vector2(0, 0);
  private ringSpin = 0;

  constructor(private container: HTMLElement) {}

  start(): void {
    this.reduced =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true, // transparente: la nebulosa la pone el CSS de fondo
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.w(), this.h());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, this.w() / this.h(), 0.1, 100);
    this.applyCamera();

    this.stage = new THREE.Group();
    this.scene.add(this.stage);

    this.buildLights();
    this.buildRune();
    this.buildDust();

    this.ring = new THREE.Group();
    this.stage.add(this.ring);
    this.loadChibis();

    // Parallax de ratón (solo puntero fino; en táctil, nada — brief).
    if (!this.reduced && matchMedia("(pointer: fine)").matches) {
      window.addEventListener("pointermove", this.onPointerMove);
    }

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    window.addEventListener("resize", this.onResize);

    this.loop();
  }

  /** Encuadre según orientación: en vertical, cámara más atrás y alta. */
  private applyCamera(): void {
    const portrait = this.h() >= this.w();
    if (portrait) {
      this.camera.position.set(0, 2.7, 8.4);
      this.camera.lookAt(0, 0.75, 0);
    } else {
      this.camera.position.set(0, 2.25, 6.7);
      this.camera.lookAt(0, 0.7, 0);
    }
  }

  private buildLights(): void {
    // Ambiental fría suave para que las sombras toon no se ennegrezcan.
    this.scene.add(new THREE.HemisphereLight(0x8894c4, 0x141726, 1.15));
    // Luz clave cálida tenue desde arriba-frente.
    const key = new THREE.DirectionalLight(0xfff2d6, 1.0);
    key.position.set(2.5, 6, 4);
    this.scene.add(key);
    // Recorte dorado (rim) desde atrás-abajo: dibuja el borde místico.
    const rim = new THREE.DirectionalLight(GOLD_BRIGHT, 1.6);
    rim.position.set(-3, 1.5, -5);
    this.scene.add(rim);
    // (El relleno dorado que sube desde la runa se añade en buildRune.)
  }

  private buildRune(): void {
    // Plano de la runa, tumbado en el suelo, emisivo aditivo.
    const runeMat = new THREE.MeshBasicMaterial({
      map: makeRuneTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.rune = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 6.4), runeMat);
    this.rune.rotation.x = -Math.PI / 2;
    this.rune.position.y = 0.01;
    this.stage.add(this.rune);

    // Halo blando bajo la runa (sprite aditivo) — el corazón dorado.
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: GOLD,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.scale.set(5.5, 5.5, 1);
    halo.position.set(0, 0.05, 0);
    this.rune.add(halo); // hijo del plano: comparte la rotación al suelo
    halo.position.set(0, 0, 0.02);
    this.runeHalo = halo;

    // Luz puntual dorada que sube desde la runa.
    const up = new THREE.PointLight(GOLD, 5.5, 9, 2);
    up.position.set(0, 0.3, 0);
    this.stage.add(up);
  }

  private buildDust(): void {
    const COUNT = 240;
    const positions = new Float32Array(COUNT * 3);
    const speeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = 0.4 + Math.random() * 4.2;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = Math.random() * 4.2;
      positions[i * 3 + 2] = Math.sin(a) * r;
      speeds[i] = 0.05 + Math.random() * 0.12;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
    const mat = new THREE.PointsMaterial({
      size: 0.055,
      map: makeGlowTexture(),
      color: GOLD_BRIGHT,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.dust = new THREE.Points(geo, mat);
    this.stage.add(this.dust);
  }

  private loadChibis(): void {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    CHIBIS.forEach((name, i) => {
      const angle = (i / CHIBIS.length) * Math.PI * 2;
      loader.load(
        `/assets/splash/${name}.glb`,
        (gltf) => {
          if (this.disposed) return;
          this.placeChibi(gltf.scene, angle);
        },
        undefined,
        () => {
          /* si un chibi falla, el círculo sigue con los demás */
        },
      );
    });
  }

  private placeChibi(root: THREE.Object3D, angle: number): void {
    // Normaliza altura (vienen a 2.0 unidades, pies en Y=-1).
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const scale = CHIBI_HEIGHT / (size.y || 2);
    root.scale.setScalar(scale);

    // Reasienta los pies en Y=0 tras escalar.
    const scaledBox = new THREE.Box3().setFromObject(root);
    root.position.y -= scaledBox.min.y;

    // Posición en el aro y giro mirando al centro (la runa).
    const x = Math.cos(angle) * RING_RADIUS;
    const z = Math.sin(angle) * RING_RADIUS;
    root.position.x = x;
    root.position.z = z;
    root.rotation.y = Math.atan2(x, z) + Math.PI; // frente (+Z) hacia el centro

    // Cel-shading + fade-in.
    const materials: THREE.MeshToonMaterial[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = false;
      const src = mesh.material as THREE.MeshStandardMaterial;
      const toon = new THREE.MeshToonMaterial({
        map: src.map ?? null,
        gradientMap: this.ramp,
        transparent: true,
        opacity: 0,
      });
      if (toon.map) toon.map.colorSpace = THREE.SRGBColorSpace;
      mesh.material = toon;
      materials.push(toon);
      src.dispose();
    });

    this.ring.add(root);
    this.chibis.push({
      root,
      materials,
      bornAt: this.clock.getElapsedTime(),
      baseY: root.position.y,
    });
  }

  private onPointerMove = (e: PointerEvent): void => {
    // -1..1 respecto al centro de la ventana.
    this.pointer.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      (e.clientY / window.innerHeight) * 2 - 1,
    );
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const t = this.clock.getElapsedTime();
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // Giro lentísimo del aro (constelación). En reduced-motion, quieto.
    if (!this.reduced) {
      this.ringSpin += dt * 0.055;
      this.ring.rotation.y = this.ringSpin; // el aro orbita como constelación

      // Respiración del conjunto.
      this.stage.position.y = Math.sin(t * 0.7) * 0.045;

      // Parallax suave: la escena se inclina 2-3° hacia el cursor.
      this.pointerLerp.lerp(this.pointer, 0.045);
      this.stage.rotation.x = this.pointerLerp.y * 0.05;
      this.stage.rotation.z = -this.pointerLerp.x * 0.04;
      this.stage.rotation.y = this.pointerLerp.x * 0.06;
    }

    // Pulso de la runa y su halo.
    const pulse = 0.75 + Math.sin(t * 1.3) * 0.2;
    (this.rune.material as THREE.MeshBasicMaterial).opacity = this.reduced ? 0.8 : pulse;
    if (this.runeHalo) {
      const s = 5.5 + (this.reduced ? 0 : Math.sin(t * 1.3) * 0.5);
      this.runeHalo.scale.set(s, s, 1);
    }

    // Fade-in por chibi + micro-respiración individual.
    for (const c of this.chibis) {
      const age = t - c.bornAt;
      const op = Math.min(1, age / 1.1);
      const eased = op * op * (3 - 2 * op); // smoothstep
      for (const m of c.materials) m.opacity = eased;
      if (!this.reduced) {
        c.root.position.y = c.baseY + Math.sin(t * 0.9 + c.baseY * 6) * 0.02;
      }
    }

    // Polvo estelar ascendente.
    if (!this.reduced) {
      const pos = this.dust.geometry.getAttribute("position") as THREE.BufferAttribute;
      const spd = this.dust.geometry.getAttribute("aSpeed") as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + spd.getX(i) * dt;
        if (y > 4.4) y = 0;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
      this.dust.rotation.y = t * 0.02;
    }

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
    this.applyCamera();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObs?.disconnect();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.ramp.dispose();
    const el = this.renderer?.domElement;
    this.renderer?.dispose();
    if (el && el.parentElement) el.parentElement.removeChild(el);
  }
}
