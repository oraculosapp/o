import * as THREE from "three";
import { RemotePlayers } from "./RemotePlayers";
import { Balls } from "./Balls";
import { ZoneSignals } from "./ZoneSignals";
import type {
  BallState,
  LocalState,
  NetAnim,
  RemoteState,
  WorldNetDeps,
  WorldNetHooks,
  ZoneSignal,
} from "./types";

/** Umbrales de velocidad horizontal (u/s) para clasificar la anim local. */
const IDLE_MAX = 0.84; // ratio 0.12 · runSpeed 7
const WALK_MAX = 4.34; // ratio 0.62 · runSpeed 7

interface TickSub {
  cb: (s: LocalState) => void;
  hz: number;
  acc: number;
}

/**
 * Orquestador de los hooks de multijugador (`world.net`). NO habla con la red:
 * compone avatares remotos, las 9 pelotas y las señales de zona, y expone el
 * contrato {@link WorldNetHooks}. Todo funciona 100% local sin red conectada.
 */
export class WorldNet implements WorldNetHooks {
  private remotes: RemotePlayers;
  private balls: Balls;
  private zones: ZoneSignals;

  private tickSubs = new Set<TickSub>();
  private time = 0;

  // Estimación de la velocidad del jugador (para patadas y anim), por delta de pos.
  private lastPos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private smoothVel = new THREE.Vector3();
  private localAnim: NetAnim = "idle";
  private started = false;

  private _fwd = new THREE.Vector3();

  constructor(private deps: WorldNetDeps) {
    this.remotes = new RemotePlayers(deps.scene);
    this.balls = new Balls(deps.field);
    this.zones = new ZoneSignals(0, 0);
  }

  /** Construye la malla de pelotas y las añade a la escena. */
  start(): void {
    this.balls.build();
    this.balls.addTo(this.deps.scene);
    this.lastPos.copy(this.deps.playerPosition);
    this.started = true;
  }

  // ---- WorldNetHooks ----

  getLocalState(): LocalState {
    const p = this.deps.playerPosition;
    this.deps.playerForward(this._fwd);
    // Frente local -Z → yaw alrededor de +Y: yaw = atan2(-fx, -fz).
    const yaw = Math.atan2(-this._fwd.x, -this._fwd.z);
    return { pos: [p.x, p.y, p.z], yaw, anim: this.localAnim };
  }

  onLocalTick(cb: (s: LocalState) => void, hz = 10): () => void {
    const sub: TickSub = { cb, hz, acc: 0 };
    this.tickSubs.add(sub);
    return () => this.tickSubs.delete(sub);
  }

  upsertRemote(id: string, s: RemoteState): void {
    this.remotes.upsert(id, s, this.time);
  }

  removeRemote(id: string): void {
    this.remotes.remove(id);
  }

  onBallKick(cb: (ballId: number, s: BallState) => void): () => void {
    return this.balls.onKick(cb);
  }

  applyBallState(ballId: number, s: BallState): void {
    this.balls.applyState(ballId, s);
  }

  onZoneSignal(cb: (signal: ZoneSignal) => void): () => void {
    return this.zones.onSignal(cb);
  }

  // ---- bucle ----

  /** Avanza todo el subsistema de red. Lo llama el loop de PaqoWorld. */
  update(dt: number): void {
    if (!this.started) return;
    this.time += dt;

    // Velocidad del jugador por delta de posición (suavizada).
    const p = this.deps.playerPosition;
    if (dt > 1e-5) this.vel.copy(p).sub(this.lastPos).divideScalar(dt);
    this.lastPos.copy(p);
    const k = 1 - Math.exp(-12 * dt);
    this.smoothVel.lerp(this.vel, k);

    // Clasifica la animación local.
    const horiz = Math.hypot(this.smoothVel.x, this.smoothVel.z);
    if (!this.deps.playerGrounded()) this.localAnim = "jump";
    else if (horiz < IDLE_MAX) this.localAnim = "idle";
    else if (horiz < WALK_MAX) this.localAnim = "walk";
    else this.localAnim = "run";

    // Subsistemas.
    this.balls.update(dt, p, this.smoothVel);
    this.remotes.update(dt, this.time, this.deps.camera);
    this.zones.update(p);

    // Ticks de estado local a la red (por defecto 10 Hz).
    if (this.tickSubs.size > 0) {
      const state = this.getLocalState();
      for (const sub of this.tickSubs) {
        sub.acc += dt;
        const period = 1 / sub.hz;
        if (sub.acc >= period) {
          sub.acc %= period;
          sub.cb(state);
        }
      }
    }
  }

  // ---- accesores para el smoke test (handle __PAQO__) ----

  /** Subsistema de pelotas (energía, estados) para QA. */
  get ballsSystem(): Balls {
    return this.balls;
  }
  /** Subsistema de zonas (distancia, found) para QA. */
  get zonesSystem(): ZoneSignals {
    return this.zones;
  }
  /** Nº de remotos vivos, para QA. */
  get remoteCount(): number {
    return this.remotes.count;
  }

  dispose(): void {
    this.tickSubs.clear();
    this.remotes.dispose();
    this.balls.dispose();
    this.zones.dispose();
    this.started = false;
  }
}
