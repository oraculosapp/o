/**
 * AvatarCarousel — RULETA 3D ceremonial de los 9 arquetipos PROCEDURALES para el
 * splash. Monta su propia escena three.js autocontenida (fondo transparente):
 * un disco de piso con la runa dorada en el centro y los 9 avatares dispuestos EN
 * CÍRCULO alrededor. El usuario gira el anillo (arrastrar horizontal / botones /
 * flechas) para traer al frente el avatar deseado, que se resalta y se acerca; el
 * giro tiene inercia y encaja (snap) en el avatar más cercano.
 *
 * No depende de PaqoWorld: usa sólo `buildArchetype(id)` del engine para instanciar
 * cada chibi rigged. `dispose()` libera todo (rigs, geometrías, materiales,
 * textura del piso, renderer). Con `reducedMotion` no hay inercia ni tweens: los
 * cambios de selección son instantáneos.
 *
 * La selección es responsabilidad de React (fuente de verdad); la ruleta reporta
 * los cambios provocados por el arrastre vía `onSelect(index)` y recibe cambios
 * programáticos vía `goTo(index)`.
 */
import * as THREE from "three";
import { buildArchetype, type IAvatarRig, type TintZone } from "@phygitalia/engine";

/** Estado idle (parado, respirando) para todos los rigs del anillo. */
const IDLE = { speed: 0, maxSpeed: 6, grounded: true, jumping: false } as const;

/** Factoría de rig para un arquetipo del anillo (p.ej. cargar su GLB modelado).
 *  Devolver `null`/rechazar mantiene el placeholder procedural (fallback). */
export type RigLoader = (archetypeId: string, index: number) => Promise<IAvatarRig | null> | IAvatarRig | null;

export interface AvatarCarouselOptions {
  /** Sin inercia ni tweens (prefers-reduced-motion). */
  reducedMotion?: boolean;
  /** Índice inicial al frente. */
  initialIndex?: number;
  /** Se llama cuando el avatar al FRENTE cambia (por arrastre o inercia). */
  onSelect?: (index: number) => void;
  /** URL de la textura de la runa central (default `/runa.png`). */
  runaUrl?: string;
  /**
   * Si se pasa, tras montar los placeholders PROCEDURALES (instantáneos) el anillo
   * carga el rig "de verdad" de cada arquetipo (p.ej. su GLB modelado) y hace
   * hot-swap al llegar. Si la carga falla, se queda el chibi procedural.
   */
  loadRig?: RigLoader;
}

export class AvatarCarousel {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private ring = new THREE.Group();

  private holders: THREE.Group[] = [];
  private rigs: IAvatarRig[] = [];
  private floorTex?: THREE.Texture;

  private readonly count: number;
  private readonly step: number;
  private readonly radius = 2.7;

  private rot = 0;
  private targetRot = 0;
  private vel = 0;
  private dragging = false;
  private lastPointerX = 0;
  private selectedIndex = 0;
  private lastReported = -1;

  private rafId = 0;
  private started = false;
  private disposed = false;
  private resizeObs?: ResizeObserver;

  private readonly reducedMotion: boolean;
  private readonly onSelect?: (index: number) => void;
  private readonly runaUrl: string;
  private readonly loadRig?: RigLoader;

  /** Tinte de 5 zonas vigente (hex), reaplicado tras cada swap de rig. */
  private tint?: Partial<Record<TintZone, string>>;
  /** Token de carga: descarta swaps de una tanda anterior (cambio de build). */
  private loadToken = 0;

  constructor(
    private container: HTMLElement,
    private ids: readonly string[],
    opts?: AvatarCarouselOptions,
  ) {
    this.count = ids.length;
    this.step = (Math.PI * 2) / this.count;
    this.reducedMotion = opts?.reducedMotion ?? false;
    this.onSelect = opts?.onSelect;
    this.runaUrl = opts?.runaUrl ?? "/runa.png";
    this.loadRig = opts?.loadRig;
    this.selectedIndex = ((opts?.initialIndex ?? 0) % this.count + this.count) % this.count;
    this.rot = -this.selectedIndex * this.step;
    this.targetRot = this.rot;
    this.lastReported = this.selectedIndex;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.w(), this.h());
    const cv = this.renderer.domElement;
    cv.style.display = "block";
    cv.style.width = "100%";
    cv.style.height = "100%";
    cv.style.touchAction = "pan-y"; // el arrastre horizontal gira; el vertical hace scroll
    cv.style.cursor = "grab";
    this.container.appendChild(cv);

    this.scene = new THREE.Scene();
    this.scene.add(this.ring);

    this.camera = new THREE.PerspectiveCamera(40, this.w() / this.h(), 0.1, 100);
    this.camera.position.set(0, 1.7, this.radius + 3.05);
    this.camera.lookAt(0, 0.75, this.radius * 0.28);

    // Luces (mismo espíritu cálido que ArchetypePreview del engine).
    const key = new THREE.DirectionalLight(0xffcf8a, 1.3);
    key.position.set(2.5, 5, 3.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb6ff, 0.42);
    rim.position.set(-3, 2.5, -2);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(0, 1.6, 6);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xf2bfc4, 0x4a3874, 0.85));

    this.buildFloor();
    this.buildRing();

    cv.addEventListener("pointerdown", this.onPointerDown);
    cv.addEventListener("pointermove", this.onPointerMove);
    cv.addEventListener("pointerup", this.onPointerUp);
    cv.addEventListener("pointercancel", this.onPointerUp);
    cv.addEventListener("pointerleave", this.onPointerUp);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);

    this.applyRingRotation();
    this.loop();
  }

  /**
   * Trae `index` al frente (animado; instantáneo con reduced-motion). No-op durante
   * el arrastre o si ese índice ya está al frente — así los cambios programáticos
   * que provienen del propio `onSelect` (arrastre/inercia) no reñían con el giro.
   */
  goTo(index: number): void {
    if (this.disposed || this.dragging) return;
    const norm = ((index % this.count) + this.count) % this.count;
    if (norm === this.selectedIndex) return;
    this.selectedIndex = norm;
    // Elige la rotación destino equivalente más cercana a la actual (evita giros largos).
    const base = -norm * this.step;
    const k = Math.round((this.rot - base) / (Math.PI * 2));
    this.targetRot = base + k * Math.PI * 2;
    this.vel = 0;
    if (this.reducedMotion) {
      this.rot = this.targetRot;
      this.applyRingRotation();
    }
    this.report(norm);
  }

  next(): void {
    this.goTo(this.selectedIndex + 1);
  }
  prev(): void {
    this.goTo(this.selectedIndex - 1);
  }

  private report(index: number): void {
    if (index === this.lastReported) return;
    this.lastReported = index;
    this.onSelect?.(index);
  }

  private buildFloor(): void {
    // Disco base oscuro bajo los pies del anillo.
    const baseGeo = new THREE.CircleGeometry(this.radius + 1.15, 64);
    const baseMat = new THREE.MeshBasicMaterial({
      color: 0x0d1020,
      transparent: true,
      opacity: 0.72,
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.03;
    this.scene.add(base);

    // Anillo dorado de borde (aro emisivo).
    const rimGeo = new THREE.RingGeometry(this.radius + 0.86, this.radius + 1.12, 64);
    const rimMat = new THREE.MeshBasicMaterial({
      color: 0xe3b063,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = -0.02;
    this.scene.add(rim);

    // Runa central (textura sobre disco). Si no carga, queda el disco dorado de abajo.
    const runaDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.35, 48),
      new THREE.MeshBasicMaterial({ color: 0xe9c07a, transparent: true, opacity: 0.28 }),
    );
    runaDisc.rotation.x = -Math.PI / 2;
    runaDisc.position.y = 0.01;
    this.scene.add(runaDisc);

    new THREE.TextureLoader().load(
      this.runaUrl,
      (tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        this.floorTex = tex;
        (runaDisc.material as THREE.MeshBasicMaterial).map = tex;
        (runaDisc.material as THREE.MeshBasicMaterial).opacity = 0.92;
        (runaDisc.material as THREE.MeshBasicMaterial).color.set(0xffffff);
        (runaDisc.material as THREE.MeshBasicMaterial).needsUpdate = true;
      },
      undefined,
      () => {
        /* sin runa.png: se queda el disco dorado tenue */
      },
    );
  }

  private buildRing(): void {
    for (let i = 0; i < this.count; i++) {
      const a = i * this.step;
      const holder = new THREE.Group();
      holder.position.set(Math.sin(a) * this.radius, 0, Math.cos(a) * this.radius);
      // El +Z local del holder apunta hacia AFUERA (radial): al frente = hacia la cámara.
      holder.rotation.y = a;

      const rig = buildArchetype(this.ids[i]);
      // El rig mira a −Z por convención del mundo; lo giramos 180° para que su CARA
      // apunte al +Z del holder (afuera → cámara cuando está al frente).
      rig.root.rotation.y = Math.PI;
      holder.add(rig.root);

      this.ring.add(holder);
      this.holders.push(holder);
      this.rigs.push(rig);
    }
    // Sube a los rigs "de verdad" (GLB modelado) si hay factoría; el chibi
    // procedural queda de placeholder instantáneo (y de fallback si la carga falla).
    if (this.loadRig) this.loadAllRigs();
  }

  /** Lanza la carga async del rig real de cada arquetipo y hace hot-swap al llegar. */
  private loadAllRigs(): void {
    const token = ++this.loadToken;
    this.ids.forEach((id, i) => {
      let out: Promise<IAvatarRig | null> | IAvatarRig | null;
      try {
        out = this.loadRig!(id, i);
      } catch {
        return;
      }
      Promise.resolve(out)
        .then((rig) => {
          if (!rig) return;
          if (this.disposed || token !== this.loadToken) {
            rig.dispose();
            return;
          }
          this.swapRigAt(i, rig);
        })
        .catch(() => {
          /* se queda el chibi procedural */
        });
    });
  }

  /** Sustituye el rig del holder `i` conservando orientación, escala y tinte. */
  private swapRigAt(i: number, rig: IAvatarRig): void {
    const holder = this.holders[i];
    const old = this.rigs[i];
    if (old) {
      holder.remove(old.root);
      old.dispose();
    }
    rig.root.rotation.y = Math.PI; // cara al +Z del holder (afuera → cámara)
    holder.add(rig.root);
    this.rigs[i] = rig;
    if (this.tint) rig.setTint(this.tintColors());
  }

  /** Convierte el tinte hex vigente a THREE.Color por zona. */
  private tintColors(): Partial<Record<TintZone, THREE.Color>> {
    const out: Partial<Record<TintZone, THREE.Color>> = {};
    if (!this.tint) return out;
    for (const zone of Object.keys(this.tint) as TintZone[]) {
      const hex = this.tint[zone];
      if (hex) out[zone] = new THREE.Color(hex);
    }
    return out;
  }

  /**
   * Fija el tinte (5 zonas, hex) y lo aplica EN VIVO a todos los rigs del anillo.
   * El editor de color del selector llama a esto en cada cambio de picker.
   */
  setTint(tint: Partial<Record<TintZone, string>>): void {
    this.tint = { ...tint };
    const colors = this.tintColors();
    for (const rig of this.rigs) rig.setTint(colors);
  }

  /**
   * Recarga los rigs "de verdad" (p.ej. al cambiar de build): re-invoca la factoría
   * y hace swap. No-op si no hay factoría (anillo puramente procedural).
   */
  reload(): void {
    if (this.loadRig) this.loadAllRigs();
  }

  private applyRingRotation(): void {
    this.ring.rotation.y = this.rot;
  }

  // ---- arrastre horizontal ----

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.vel = 0;
    this.lastPointerX = e.clientX;
    this.renderer.domElement.style.cursor = "grabbing";
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastPointerX;
    this.lastPointerX = e.clientX;
    const dr = dx * 0.009;
    this.rot += dr;
    // Velocidad angular suavizada para la inercia (ignorada con reduced-motion).
    this.vel = this.reducedMotion ? 0 : this.vel * 0.6 + dr * 0.4;
    this.applyRingRotation();
    this.updateSelectedFromRot();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.renderer.domElement.style.cursor = "grab";
    this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    if (this.reducedMotion) {
      // Encaja al más cercano al instante.
      this.snapTarget();
      this.rot = this.targetRot;
      this.applyRingRotation();
      this.updateSelectedFromRot();
    }
    // Con movimiento: la inercia del loop se encarga (vel ya está cargada).
  };

  /** Fija `targetRot` al múltiplo de paso más cercano a la rotación actual. */
  private snapTarget(): void {
    const stepsFromZero = Math.round(this.rot / this.step);
    this.targetRot = stepsFromZero * this.step;
  }

  /** Recalcula el índice al frente a partir de `rot` y lo reporta si cambió. */
  private updateSelectedFromRot(): void {
    // Front (ángulo 0): i*step + rot ≡ 0 → i = -rot/step.
    let idx = Math.round(-this.rot / this.step) % this.count;
    idx = ((idx % this.count) + this.count) % this.count;
    this.selectedIndex = idx;
    this.report(idx);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (!this.dragging && !this.reducedMotion) {
      if (Math.abs(this.vel) > 0.0008) {
        // Inercia: aplica velocidad con amortiguación exponencial.
        this.rot += this.vel;
        this.vel *= 0.94;
        this.applyRingRotation();
        this.updateSelectedFromRot();
        if (Math.abs(this.vel) <= 0.0008) this.snapTarget();
      } else {
        // Reposo: ease suave hacia el snap más cercano.
        this.snapTarget();
        const diff = this.targetRot - this.rot;
        if (Math.abs(diff) > 0.0004) {
          this.rot += diff * Math.min(1, dt * 9);
          this.applyRingRotation();
          this.updateSelectedFromRot();
        }
      }
    } else if (!this.dragging && this.reducedMotion) {
      // Sin animación: engancha directo al destino programático.
      if (this.rot !== this.targetRot) {
        this.rot = this.targetRot;
        this.applyRingRotation();
        this.updateSelectedFromRot();
      }
    }

    // Resalta y acerca el avatar al frente; encoge los demás.
    for (let i = 0; i < this.holders.length; i++) {
      const holder = this.holders[i];
      const worldAngle = i * this.step + this.rot;
      const frontness = Math.max(0, Math.cos(worldAngle)); // 1 al frente, 0 a los lados
      const target = 0.72 + 0.4 * frontness * frontness;
      const s = holder.scale.x + (target - holder.scale.x) * Math.min(1, dt * 8);
      holder.scale.setScalar(s);
      this.rigs[i]?.update(dt, IDLE);
    }

    this.renderer.render(this.scene, this.camera);
  };

  private w(): number {
    return this.container.clientWidth || 360;
  }
  private h(): number {
    return this.container.clientHeight || 380;
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
    const cv = this.renderer?.domElement;
    if (cv) {
      cv.removeEventListener("pointerdown", this.onPointerDown);
      cv.removeEventListener("pointermove", this.onPointerMove);
      cv.removeEventListener("pointerup", this.onPointerUp);
      cv.removeEventListener("pointercancel", this.onPointerUp);
      cv.removeEventListener("pointerleave", this.onPointerUp);
    }
    for (const rig of this.rigs) rig.dispose();
    this.rigs = [];
    this.holders = [];
    this.floorTex?.dispose();
    this.scene?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.renderer?.dispose();
    if (cv && cv.parentElement) cv.parentElement.removeChild(cv);
  }
}
