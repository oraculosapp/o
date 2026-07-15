import * as THREE from "three";

/**
 * DrawTrail — modo DIBUJAR (equipo Vuelo/Mandos).
 *
 * Con el modo activo, el avatar deja una LÍNEA DE COLORES continua (estela
 * arcoíris) que persiste ~LIFE s y se desvanece. Se dibuja desde la posición del
 * jugador a la altura pies+0.5. Es un RIBBON de triángulos (una tira que mira a
 * la cámara) con vertex colors que ciclan el matiz y BLENDING ADITIVO suave → un
 * trazo de neón que respira. Cap de puntos (~CAP) con reciclaje (se sueltan los
 * trazos/puntos más viejos). 1 draw call (un solo Mesh).
 *
 * Multijugador: el trazo local se trocea en LOTES (`emitBatch`, ≤BATCH_MAX puntos
 * cada ~BATCH_PERIOD s) que la capa de red difunde; los trazos remotos entran por
 * `applyRemoteBatch` y se pintan con el MISMO sistema. Cada trazo (owner+id) es
 * un segmento CONTIGUO e independiente: interleaving local/remoto nunca rompe una
 * línea (cada trazo guarda sus puntos aparte).
 *
 * NOTA: módulo del engine — NO importa React.
 */

/** Tope global de puntos vivos (centro del ribbon). ~2000 como pidió el brief. */
const CAP = 2000;
/** Persistencia de cada punto antes de desvanecerse del todo (s). */
const LIFE = 30;
/** Semiancho del ribbon (u). Fino como un tubo. */
const HALF_WIDTH = 0.06;
/** Distancia mínima entre puntos del trazo local (u) — evita densidad inútil. */
const MIN_STEP = 0.14;
/** Puntos por lote de difusión y periodo de emisión. */
const BATCH_MAX = 40;
const BATCH_PERIOD = 0.5;
/** Paso de matiz por punto (ciclo arcoíris a lo largo del trazo). */
const HUE_STEP = 0.018;
/** Altura sobre los pies desde la que sale el trazo. */
const DRAW_HEIGHT = 0.5;

interface DrawPoint {
  x: number;
  y: number;
  z: number;
  birth: number;
  hue: number;
}

interface Stroke {
  key: string; // `${owner}:${id}`
  pts: DrawPoint[];
  done: boolean;
  touched: number; // último instante con puntos añadidos (para reciclar los viejos)
}

/** Lote de puntos de un trazo para difundir por la red (o aplicar de un remoto). */
export interface DrawBatch {
  /** Id del trazo del emisor (monótono creciente por emisor). */
  stroke: number;
  /** Puntos planos [x,y,z, x,y,z, …] a la altura ya calculada (pies+0.5). */
  points: number[];
}

export class DrawTrail {
  private geo = new THREE.BufferGeometry();
  private mat: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh;

  // Buffers pre-reservados (2 vértices por punto → ribbon). Se reescriben/frame.
  private positions = new Float32Array(CAP * 2 * 3);
  private colors = new Float32Array(CAP * 2 * 3);
  private indices = new Uint16Array(CAP * 6);
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private indexAttr: THREE.BufferAttribute;

  private strokes: Stroke[] = [];
  private time = 0;
  private drawing = false;
  private localStrokeId = -1;
  private localEmitted = 0; // puntos del trazo local ya difundidos
  private batchTimer = 0;
  private hueCursor = 0;

  /** Suscriptores de lotes locales (los engancha la capa de red). */
  private batchSubs = new Set<(b: DrawBatch) => void>();

  // Reusables (sin garbage por frame).
  private _center = new THREE.Vector3();
  private _next = new THREE.Vector3();
  private _seg = new THREE.Vector3();
  private _view = new THREE.Vector3();
  private _side = new THREE.Vector3();
  private _col = new THREE.Color();
  private _cam = new THREE.Vector3();

  constructor() {
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.indexAttr = new THREE.BufferAttribute(this.indices, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.posAttr);
    this.geo.setAttribute("color", this.colAttr);
    this.geo.setIndex(this.indexAttr);
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // ---- API pública (world.setDrawing / world.isDrawing) ----

  /** Activa/desactiva el modo dibujar. Al activar arranca un trazo local nuevo. */
  setDrawing(on: boolean): void {
    if (on === this.drawing) return;
    this.drawing = on;
    if (on) {
      this.localStrokeId += 1;
      this.localEmitted = 0;
      this.batchTimer = 0;
      this.getStroke("local", this.localStrokeId); // crea el trazo vacío
    } else {
      // Cierra el trazo local y difunde lo que quede pendiente.
      const s = this.strokes.find((k) => k.key === `local:${this.localStrokeId}`);
      if (s) s.done = true;
      this.flushLocalBatch(true);
    }
  }

  isDrawing(): boolean {
    return this.drawing;
  }

  /** Suscribe lotes locales para difundir por la red. Devuelve la función de baja. */
  onBatch(cb: (b: DrawBatch) => void): () => void {
    this.batchSubs.add(cb);
    return () => this.batchSubs.delete(cb);
  }

  /**
   * Aplica un lote de un trazo REMOTO (mismo sistema de pintado). `owner` = id de
   * sesión del emisor. Valida forma mínima (números finitos); el saneo M-5 fuerte
   * ya lo hace la capa de red antes de llegar aquí.
   */
  applyRemoteBatch(owner: string, batch: DrawBatch): void {
    const s = this.getStroke(owner, batch.stroke);
    const p = batch.points;
    for (let i = 0; i + 2 < p.length; i += 3) {
      this.pushPoint(s, p[i], p[i + 1], p[i + 2]);
    }
  }

  // ---- bucle ----

  /**
   * Actualiza el trazo local (añade puntos desde la posición del jugador),
   * reconstruye la geometría del ribbon mirando a la cámara y aplica el fade.
   * `feetY` = altura de los pies (el trazo sale a feetY+0.5).
   */
  update(dt: number, playerPos: THREE.Vector3, feetY: number, camera: THREE.Camera): void {
    this.time += dt;

    if (this.drawing) {
      const s = this.getStroke("local", this.localStrokeId);
      this.pushPoint(s, playerPos.x, feetY + DRAW_HEIGHT, playerPos.z);
      this.batchTimer += dt;
      if (this.batchTimer >= BATCH_PERIOD) {
        this.batchTimer = 0;
        this.flushLocalBatch(false);
      }
    }

    this.cull();
    camera.getWorldPosition(this._cam);
    this.rebuild(this._cam);
  }

  // ---- trazos ----

  private getStroke(owner: string, id: number): Stroke {
    const key = `${owner}:${id}`;
    let s = this.strokes.find((k) => k.key === key);
    if (!s) {
      s = { key, pts: [], done: false, touched: this.time };
      this.strokes.push(s);
    }
    return s;
  }

  /** Añade un punto al trazo respetando el paso mínimo. Asigna matiz (arcoíris). */
  private pushPoint(s: Stroke, x: number, y: number, z: number): void {
    const last = s.pts[s.pts.length - 1];
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      const dz = z - last.z;
      if (dx * dx + dy * dy + dz * dz < MIN_STEP * MIN_STEP) return;
    }
    this.hueCursor = (this.hueCursor + HUE_STEP) % 1;
    s.pts.push({ x, y, z, birth: this.time, hue: this.hueCursor });
    s.touched = this.time;
    this.enforceCap();
  }

  /** Difunde los puntos del trazo local aún no enviados (en lotes de ≤BATCH_MAX). */
  private flushLocalBatch(_final: boolean): void {
    const s = this.strokes.find((k) => k.key === `local:${this.localStrokeId}`);
    if (!s) return;
    if (this.batchSubs.size === 0) {
      this.localEmitted = s.pts.length; // sin red: nada que difundir, pero no re-enviar
      return;
    }
    // Envía todo lo pendiente troceado en lotes de ≤BATCH_MAX puntos.
    while (this.localEmitted < s.pts.length) {
      const end = Math.min(this.localEmitted + BATCH_MAX, s.pts.length);
      const points: number[] = [];
      for (let i = this.localEmitted; i < end; i++) {
        points.push(s.pts[i].x, s.pts[i].y, s.pts[i].z);
      }
      this.localEmitted = end;
      const batch: DrawBatch = { stroke: this.localStrokeId, points };
      for (const cb of this.batchSubs) cb(batch);
    }
  }

  /** Cap global de puntos: suelta los puntos más viejos de los trazos más viejos. */
  private enforceCap(): void {
    let total = 0;
    for (const s of this.strokes) total += s.pts.length;
    if (total <= CAP) return;
    let over = total - CAP;
    // Recorre trazos de más viejo a más nuevo soltando su frente.
    for (const s of this.strokes) {
      if (over <= 0) break;
      const drop = Math.min(over, s.pts.length);
      if (drop > 0) {
        s.pts.splice(0, drop);
        this.onFrontDropped(s, drop);
        over -= drop;
      }
    }
    this.strokes = this.strokes.filter((s) => s.pts.length > 0 || !s.done);
  }

  /** Retira puntos muertos (edad>LIFE) del frente de cada trazo y trazos vacíos. */
  private cull(): void {
    const cutoff = this.time - LIFE;
    for (const s of this.strokes) {
      let drop = 0;
      while (drop < s.pts.length && s.pts[drop].birth < cutoff) drop++;
      if (drop > 0) {
        s.pts.splice(0, drop);
        this.onFrontDropped(s, drop);
      }
    }
    this.strokes = this.strokes.filter((s) => s.pts.length > 0);
  }

  /** Mantiene `localEmitted` coherente si se soltó el frente del trazo local vivo. */
  private onFrontDropped(s: Stroke, drop: number): void {
    if (s.key === `local:${this.localStrokeId}`) {
      this.localEmitted = Math.max(0, this.localEmitted - drop);
    }
  }

  /** Nº de puntos vivos (centro del ribbon). Para QA/tests. */
  pointCount(): number {
    let n = 0;
    for (const s of this.strokes) n += s.pts.length;
    return n;
  }

  /** Nº de trazos vivos. Para QA/tests. */
  strokeCount(): number {
    return this.strokes.length;
  }

  // ---- geometría ----

  /**
   * Reconstruye el ribbon: para cada punto vivo, dos vértices offset ±HALF_WIDTH
   * en la dirección perpendicular al segmento y a la vista (ribbon que mira a la
   * cámara). Color = HSL(hue) escalado por el fade (aditivo → negro = invisible).
   */
  private rebuild(camPos: THREE.Vector3): void {
    let v = 0; // índice de vértice
    let idx = 0; // índice de triángulo (posición en this.indices)

    for (const s of this.strokes) {
      const n = s.pts.length;
      const strokeStartVert = v;
      for (let i = 0; i < n; i++) {
        const p = s.pts[i];
        this._center.set(p.x, p.y, p.z);
        // Dirección del segmento (al siguiente, o al anterior en el último punto).
        if (i < n - 1) {
          const q = s.pts[i + 1];
          this._seg.set(q.x - p.x, q.y - p.y, q.z - p.z);
        } else if (i > 0) {
          const q = s.pts[i - 1];
          this._seg.set(p.x - q.x, p.y - q.y, p.z - q.z);
        } else {
          this._seg.set(1, 0, 0); // punto suelto: eje arbitrario
        }
        if (this._seg.lengthSq() < 1e-10) this._seg.set(1, 0, 0);
        this._seg.normalize();
        // Vista (punto→cámara) para orientar el ancho hacia el espectador.
        this._view.copy(camPos).sub(this._center);
        if (this._view.lengthSq() < 1e-10) this._view.set(0, 0, 1);
        this._view.normalize();
        this._side.crossVectors(this._seg, this._view);
        if (this._side.lengthSq() < 1e-10) this._side.set(0, 1, 0);
        this._side.normalize().multiplyScalar(HALF_WIDTH);

        // Fade por edad (suave). Aditivo: color*fade, 0 = transparente.
        const age = this.time - p.birth;
        const fade = Math.max(0, 1 - age / LIFE);
        const f = fade * fade; // curva suave al final
        this._col.setHSL(p.hue, 0.85, 0.55).multiplyScalar(f);

        const a = v * 3;
        this.positions[a] = this._center.x + this._side.x;
        this.positions[a + 1] = this._center.y + this._side.y;
        this.positions[a + 2] = this._center.z + this._side.z;
        this.positions[a + 3] = this._center.x - this._side.x;
        this.positions[a + 4] = this._center.y - this._side.y;
        this.positions[a + 5] = this._center.z - this._side.z;
        this.colors[a] = this.colors[a + 3] = this._col.r;
        this.colors[a + 1] = this.colors[a + 4] = this._col.g;
        this.colors[a + 2] = this.colors[a + 5] = this._col.b;
        v += 2;
      }
      // Índices: un quad (2 triángulos) por segmento interno del trazo.
      for (let i = 0; i < n - 1; i++) {
        const base = strokeStartVert + i * 2;
        // Vértices: base, base+1 (punto i) · base+2, base+3 (punto i+1).
        this.indices[idx++] = base;
        this.indices[idx++] = base + 1;
        this.indices[idx++] = base + 2;
        this.indices[idx++] = base + 1;
        this.indices[idx++] = base + 3;
        this.indices[idx++] = base + 2;
      }
    }

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.indexAttr.needsUpdate = true;
    this.geo.setDrawRange(0, idx);
  }

  dispose(): void {
    this.batchSubs.clear();
    this.mesh.parent?.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
