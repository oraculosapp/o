import * as THREE from "three";
import type { Balls } from "../net/Balls";
import type { IslandField } from "../island/IslandField";
import type { GameEvent } from "../net/types";

/**
 * BallGame — mini-juego "¡Dale a Paqo!" (equipo Juego).
 *
 * Lógica del mini-juego competitivo de golpear al tótem (Paqo) con las pelotas:
 * arranque local que emite un evento por el canal de la biósfera, ronda con cuenta
 * atrás de 3 min, puntuación por jugador, detección de impactos (autoridad del
 * lanzador), FX/sonido y resolución de ganadores. NO habla con la red directamente:
 * emite y recibe {@link GameEvent} a través de callbacks que la capa de red
 * (apps/web) cablea. Funciona 100% LOCAL sin red (jugando sola: marcador de 1).
 *
 * NOTA: módulo del engine — NO importa React.
 */

/** Fase del ciclo de una partida. */
export type GamePhase = "idle" | "running" | "results";

/** Instantánea del estado del juego (la consume el HUD). */
export interface GameSnapshot {
  phase: GamePhase;
  /** Epoch ms en que termina la ronda; 0 si idle. */
  endsAt: number;
  /** playerId → puntos. */
  scores: Record<string, number>;
  /** Quién inició la partida. */
  startedBy: string;
  /** Ganadores; vacío salvo en la fase "results". */
  winnerIds: string[];
  /** playerId → nombre visible (roster + eventos; sticky). Para pintar el marcador. */
  names: Record<string, string>;
  /** Id del jugador LOCAL (para resaltar "tú" en el marcador). */
  localId: string;
}

/** Dependencias que el juego toma del mundo. */
export interface BallGameHooks {
  scene: THREE.Scene;
  balls: Balls;
  field: IslandField;
  /** Devuelve el grupo del tótem (o null si aún no cargó). */
  getTotem: () => THREE.Group | null;
  /** Reproduce un sonido del juego (impacto/inicio/fin) → Soundscape. */
  onSound: (kind: "hit" | "start" | "end") => void;
}

/** Duración de una ronda (ms): 3 minutos. */
const ROUND_MS = 180_000;
/** Duración de la pantalla de resultados (ms) antes de volver a idle. */
const RESULTS_MS = 8_000;
/** Cadencia base del beacon de estado en running (s) + jitter aleatorio. */
const BEACON_MIN = 5;
const BEACON_JITTER = 2;

/** Radio de la pelota (u) — coincide con Balls.RADIUS; ensancha el cilindro. */
const BALL_RADIUS = 0.35;
/** Factor del radio del cilindro de golpe respecto al ancho del tótem. */
const CYL_SCALE = 0.8;

/** Nº de ráfagas de chispas en el pool (sin allocs por frame). */
const BURST_COUNT = 3;
/** Chispas por ráfaga. */
const SPARKS_PER = 24;
/** Vida de una ráfaga (s). */
const SPARK_LIFE = 0.6;
/** Gravedad suave de las chispas (u/s²). */
const SPARK_GRAVITY = 5.5;

/** Colores de las chispas: dorado y rosa de marca. */
const SPARK_GOLD = new THREE.Color("#E3B063");
const SPARK_PINK = new THREE.Color("#F2A6B8");
/** Color del flash emisivo del tótem al golpe. */
const FLASH_GOLD = new THREE.Color("#e3b063");
/** Intensidad emisiva pico del flash. */
const FLASH_PEAK = 1.2;
/** Decaimiento del flash (s). */
const FLASH_DECAY = 0.5;
/** Fracción del flash/FX cuando el golpe NO puntúa (sin partida activa). */
const SOFT_FACTOR = 0.4;
/** Restitución del rebote de cortesía cuando no hay partida. */
const SOFT_RESTITUTION = 0.5;

interface SparkBurst {
  points: THREE.Points;
  positions: Float32Array;
  velocities: Float32Array;
  material: THREE.PointsMaterial;
  life: number;
  maxLife: number;
}

interface FlashMat {
  mat: THREE.MeshToonMaterial;
  baseColor: THREE.Color;
  baseIntensity: number;
}

/**
 * Motor del mini-juego. Máquina de fases idle→running→results→idle, detección de
 * impactos por autoridad del lanzador, FX procedurales (chispas + flash del tótem)
 * y beacon de estado para late-joiners.
 */
export class BallGame {
  private phase: GamePhase = "idle";
  private endsAt = 0;
  private startedBy = "";
  private scores: Record<string, number> = {};
  private names: Record<string, string> = {};
  private winnerIds: string[] = [];
  private localId = "local";
  private resultsUntil = 0;

  private beaconAcc = 0;
  private nextBeacon = this.pickBeacon();

  private changeCbs = new Set<(s: GameSnapshot) => void>();
  private eventCbs = new Set<(e: GameEvent) => void>();
  private unsubRespawn: (() => void) | null = null;

  // Cilindro de golpe del tótem (cacheado; se recalcula si el group cambia).
  private cachedTotem: THREE.Group | null = null;
  private cyl: { cx: number; cz: number; radius: number; minY: number; maxY: number } | null = null;

  // FX.
  private bursts: SparkBurst[] = [];
  private flashMats: FlashMat[] = [];
  private flashAmt = 0;
  private flashDirty = false;

  private _v = new THREE.Vector3();
  private _box = new THREE.Box3();
  private _size = new THREE.Vector3();

  constructor(private hooks: BallGameHooks) {
    // Poof de "materialización" cuando una pelota respawnea por salir de la zona.
    // Los golpes ("hit") ya disparan su FX en la ruta de impacto, así que aquí sólo
    // reaccionamos a "out" (y damos a onRespawn un consumidor de FX real).
    this.unsubRespawn = hooks.balls.onRespawn((_id, s, reason) => {
      if (reason === "out") this.triggerSpark(s.pos[0], s.pos[1], s.pos[2], true);
    });
  }

  // ---- API pública ----------------------------------------------------------

  /** Fija el id del jugador local (se usa para puntuar y emitir eventos). */
  setLocalPlayer(id: string): void {
    this.localId = id || "local";
    if (this.names[this.localId]) this.notifyChange();
  }

  /**
   * Fusiona nombres visibles (roster de presencia y/o eventos). Sticky: nunca borra,
   * así los jugadores que se van conservan su nombre en el marcador. Notifica al HUD
   * sólo si algo cambió.
   */
  mergeNames(names: Record<string, string>): void {
    let changed = false;
    for (const id of Object.keys(names)) {
      const n = names[id];
      if (n && this.names[id] !== n) {
        this.names[id] = n;
        changed = true;
      }
    }
    if (changed) this.notifyChange();
  }

  /** Inicia la partida local y emite el evento "start". Cualquiera puede (sin permisos). */
  start(): void {
    if (this.phase !== "idle" && this.phase !== "results") return;
    const endsAt = Date.now() + ROUND_MS;
    this.enterRunning(endsAt, this.localId);
    this.emit({ type: "start", by: this.localId, endsAt });
    this.hooks.onSound("start");
  }

  /** Detiene la partida local y emite "stop". Cualquiera puede. */
  stop(): void {
    if (this.phase !== "running") return;
    this.emit({ type: "stop", by: this.localId });
    this.enterIdle();
  }

  /** Aplica un evento recibido de la red (reconciliación de estado idempotente). */
  applyRemote(e: GameEvent): void {
    switch (e.type) {
      case "start":
        if (this.phase !== "running") {
          this.enterRunning(e.endsAt, e.by);
        } else {
          this.endsAt = e.endsAt;
          if (!this.startedBy) this.startedBy = e.by;
          this.notifyChange();
        }
        break;
      case "stop":
        if (this.phase === "running") this.enterIdle();
        break;
      case "hit":
        this.scores[e.by] = (this.scores[e.by] ?? 0) + 1;
        this.triggerSpark(e.hitPos[0], e.hitPos[1], e.hitPos[2], false);
        this.flash(false);
        this.hooks.onSound("hit");
        this.hooks.balls.respawnToHome(e.ballId, "hit");
        this.notifyChange();
        break;
      case "state":
        this.mergeState(e);
        break;
    }
  }

  /** Suscribe eventos locales (para que la red los propague). Devuelve unsub. */
  onLocalEvent(cb: (e: GameEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /** Suscribe cambios de snapshot (para el HUD). Devuelve unsub. */
  onChange(cb: (s: GameSnapshot) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  /** Instantánea consistente del estado actual del juego. */
  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      endsAt: this.endsAt,
      scores: { ...this.scores },
      startedBy: this.startedBy,
      winnerIds: this.winnerIds.slice(),
      names: { ...this.names },
      localId: this.localId,
    };
  }

  // ---- bucle ----------------------------------------------------------------

  /** Avanza la simulación del juego por frame (cuenta atrás, impactos, FX, beacon). */
  update(dt: number): void {
    this.updateFx(dt);
    this.refreshTotem();

    // Detección de golpe: SOLO para las pelotas thrownLive del jugador local
    // (autoridad del lanzador). Corre en todas las fases; el efecto depende de si
    // hay partida activa.
    if (this.cyl) {
      const balls = this.hooks.balls;
      for (let i = 0; i < balls.count; i++) {
        if (!balls.isThrownLive(i)) continue;
        balls.positionOf(i, this._v);
        if (this.insideCyl(this._v)) this.handleHit(i, this._v);
      }
    }

    const now = Date.now();
    if (this.phase === "running") {
      this.beaconAcc += dt;
      if (this.beaconAcc >= this.nextBeacon) {
        this.beaconAcc = 0;
        this.nextBeacon = this.pickBeacon();
        this.emit({
          type: "state",
          endsAt: this.endsAt,
          scores: { ...this.scores },
          startedBy: this.startedBy,
        });
      }
      if (now >= this.endsAt) this.enterResults();
    } else if (this.phase === "results") {
      if (now >= this.resultsUntil) this.enterIdle();
    }
  }

  // ---- transiciones de fase -------------------------------------------------

  private enterRunning(endsAt: number, by: string): void {
    this.phase = "running";
    this.endsAt = endsAt;
    this.startedBy = by;
    this.scores = {};
    this.winnerIds = [];
    this.beaconAcc = 0;
    this.nextBeacon = this.pickBeacon();
    this.notifyChange();
  }

  private enterResults(): void {
    this.phase = "results";
    this.winnerIds = this.computeWinners();
    this.resultsUntil = Date.now() + RESULTS_MS;
    this.hooks.onSound("end");
    this.notifyChange();
  }

  private enterIdle(): void {
    this.phase = "idle";
    this.endsAt = 0;
    this.startedBy = "";
    this.scores = {};
    this.winnerIds = [];
    this.notifyChange();
  }

  /** Merge idempotente del beacon de estado (late-joiners y supervivencia). */
  private mergeState(e: Extract<GameEvent, { type: "state" }>): void {
    if (this.phase !== "running") {
      // Late-join: adopta la partida en curso SIN borrar puntuaciones (se fusionan).
      if (e.endsAt > Date.now()) {
        this.phase = "running";
        this.endsAt = e.endsAt;
        this.startedBy = e.startedBy;
        this.winnerIds = [];
        this.beaconAcc = 0;
        this.nextBeacon = this.pickBeacon();
      }
    } else {
      if (e.endsAt) this.endsAt = Math.max(this.endsAt, e.endsAt);
      if (!this.startedBy) this.startedBy = e.startedBy;
    }
    // Puntos por jugador = max(local, recibido): aplicar dos veces no cambia nada.
    for (const id of Object.keys(e.scores)) {
      this.scores[id] = Math.max(this.scores[id] ?? 0, e.scores[id]);
    }
    this.notifyChange();
  }

  private computeWinners(): string[] {
    let max = 0;
    for (const v of Object.values(this.scores)) if (v > max) max = v;
    if (max <= 0) return [];
    return Object.keys(this.scores).filter((k) => this.scores[k] === max);
  }

  private pickBeacon(): number {
    return BEACON_MIN + Math.random() * BEACON_JITTER;
  }

  // ---- impacto --------------------------------------------------------------

  private handleHit(id: number, pos: THREE.Vector3): void {
    if (this.phase === "running") {
      this.scores[this.localId] = (this.scores[this.localId] ?? 0) + 1;
      this.emit({
        type: "hit",
        by: this.localId,
        ballId: id,
        hitPos: [pos.x, pos.y, pos.z],
      });
      this.triggerSpark(pos.x, pos.y, pos.z, false);
      this.flash(false);
      this.hooks.onSound("hit");
      this.hooks.balls.respawnToHome(id, "hit");
      this.notifyChange();
    } else {
      // Sin partida: Paqo reacciona un poquito (FX suave + rebote), sin punto.
      this.triggerSpark(pos.x, pos.y, pos.z, true);
      this.flash(true);
      if (this.cyl) {
        this.hooks.balls.deflect(id, this.cyl.cx, this.cyl.cz, this.cyl.radius, SOFT_RESTITUTION);
      }
    }
  }

  private refreshTotem(): void {
    const g = this.hooks.getTotem();
    // El group cambió (incluye → null): invalida cilindro y baselines de flash.
    if (g !== this.cachedTotem) {
      this.cachedTotem = g;
      this.cyl = null;
      this.flashMats = [];
    }
    // Sin tótem, o ya resuelto: nada que recalcular.
    if (!g || this.cyl) return;
    // Cilindro de golpe desde el Box3 del group. El group nace VACÍO y el modelo se
    // añade async: mientras el box esté vacío reintentamos (barato) frame a frame,
    // y sólo fijamos el cilindro cuando el tótem ya tiene geometría ("de null a vivo").
    this._box.setFromObject(g);
    if (this._box.isEmpty()) return;
    this._box.getSize(this._size);
    const cx = (this._box.min.x + this._box.max.x) / 2;
    const cz = (this._box.min.z + this._box.max.z) / 2;
    const radius = (Math.max(this._size.x, this._size.z) / 2) * CYL_SCALE + BALL_RADIUS;
    this.cyl = { cx, cz, radius, minY: this._box.min.y, maxY: this._box.max.y };
    // Baselines de emissive de los materiales toon (para el flash).
    g.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of list) {
        if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) {
          const tm = m as THREE.MeshToonMaterial;
          this.flashMats.push({
            mat: tm,
            baseColor: tm.emissive.clone(),
            baseIntensity: tm.emissiveIntensity,
          });
        }
      }
    });
  }

  private insideCyl(p: THREE.Vector3): boolean {
    const c = this.cyl!;
    if (p.y < c.minY || p.y > c.maxY) return false;
    return Math.hypot(p.x - c.cx, p.z - c.cz) <= c.radius;
  }

  // ---- FX: chispas + flash del tótem ---------------------------------------

  private ensureFx(): void {
    if (this.bursts.length > 0) return;
    for (let b = 0; b < BURST_COUNT; b++) {
      const positions = new Float32Array(SPARKS_PER * 3);
      const colors = new Float32Array(SPARKS_PER * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({
        size: 0.28,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const points = new THREE.Points(geo, material);
      points.frustumCulled = false;
      points.visible = false;
      points.renderOrder = 5;
      this.hooks.scene.add(points);
      this.bursts.push({
        points,
        positions,
        velocities: new Float32Array(SPARKS_PER * 3),
        material,
        life: 0,
        maxLife: SPARK_LIFE,
      });
    }
  }

  /** Ráfaga de chispas doradas/rosas desde un punto. `soft` reduce vida/tamaño. */
  private triggerSpark(x: number, y: number, z: number, soft: boolean): void {
    this.ensureFx();
    const burst = this.bursts.find((b) => b.life <= 0) ?? this.bursts[0];
    if (!burst) return;
    const maxLife = SPARK_LIFE * (soft ? SOFT_FACTOR + 0.3 : 1);
    const speed = soft ? 2.2 : 4.2;
    const colorAttr = burst.points.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < SPARKS_PER; i++) {
      const i3 = i * 3;
      burst.positions[i3] = x;
      burst.positions[i3 + 1] = y;
      burst.positions[i3 + 2] = z;
      // Dirección aleatoria en esfera, sesgada hacia arriba.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.4 + Math.random() * 0.6);
      burst.velocities[i3] = Math.sin(phi) * Math.cos(theta) * sp;
      burst.velocities[i3 + 1] = Math.abs(Math.cos(phi)) * sp + 1.2;
      burst.velocities[i3 + 2] = Math.sin(phi) * Math.sin(theta) * sp;
      c.copy(Math.random() < 0.5 ? SPARK_GOLD : SPARK_PINK);
      colorAttr.setXYZ(i, c.r, c.g, c.b);
    }
    colorAttr.needsUpdate = true;
    (burst.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    burst.material.size = soft ? 0.2 : 0.28;
    burst.life = maxLife;
    burst.maxLife = maxLife;
    burst.material.opacity = 1;
    burst.points.visible = true;
  }

  private flash(soft: boolean): void {
    this.flashAmt = Math.max(this.flashAmt, soft ? SOFT_FACTOR : 1);
    this.flashDirty = true;
  }

  private updateFx(dt: number): void {
    // Chispas.
    for (const burst of this.bursts) {
      if (burst.life <= 0) continue;
      const posAttr = burst.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < SPARKS_PER; i++) {
        const i3 = i * 3;
        burst.velocities[i3 + 1] -= SPARK_GRAVITY * dt;
        burst.positions[i3] += burst.velocities[i3] * dt;
        burst.positions[i3 + 1] += burst.velocities[i3 + 1] * dt;
        burst.positions[i3 + 2] += burst.velocities[i3 + 2] * dt;
      }
      posAttr.needsUpdate = true;
      burst.life -= dt;
      burst.material.opacity = Math.max(0, burst.life / burst.maxLife);
      if (burst.life <= 0) burst.points.visible = false;
    }

    // Flash del tótem (pulso de emissive con decay).
    if (this.flashAmt > 0 || this.flashDirty) {
      for (const f of this.flashMats) {
        f.mat.emissive.copy(f.baseColor).lerp(FLASH_GOLD, this.flashAmt);
        f.mat.emissiveIntensity = f.baseIntensity * (1 - this.flashAmt) + FLASH_PEAK * this.flashAmt;
      }
      this.flashAmt = Math.max(0, this.flashAmt - dt / FLASH_DECAY);
      if (this.flashAmt <= 0) {
        // Restaura baselines exactas una última vez.
        for (const f of this.flashMats) {
          f.mat.emissive.copy(f.baseColor);
          f.mat.emissiveIntensity = f.baseIntensity;
        }
        this.flashDirty = false;
      }
    }
  }

  // ---- notificación ---------------------------------------------------------

  private emit(e: GameEvent): void {
    for (const cb of this.eventCbs) cb(e);
  }

  private notifyChange(): void {
    if (this.changeCbs.size === 0) return;
    const snap = this.snapshot();
    for (const cb of this.changeCbs) cb(snap);
  }

  // ---- limpieza -------------------------------------------------------------

  /** Libera recursos propios del juego. */
  dispose(): void {
    this.changeCbs.clear();
    this.eventCbs.clear();
    this.unsubRespawn?.();
    this.unsubRespawn = null;
    // Restaura baselines por si el tótem sobrevive al juego.
    for (const f of this.flashMats) {
      f.mat.emissive.copy(f.baseColor);
      f.mat.emissiveIntensity = f.baseIntensity;
    }
    this.flashMats = [];
    for (const burst of this.bursts) {
      this.hooks.scene.remove(burst.points);
      burst.points.geometry.dispose();
      burst.material.dispose();
    }
    this.bursts = [];
  }
}
