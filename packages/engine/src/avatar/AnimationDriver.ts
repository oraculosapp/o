import * as THREE from "three";
import type { AvatarDriveState } from "./types";

/** Estados de locomoción que el driver sabe reproducir. */
export type Locomotion = "idle" | "walk" | "run" | "jump";

/** Duración del crossfade entre clips (s). */
const FADE = 0.2;

interface Resolved {
  action: THREE.AnimationAction;
  /** Velocidad (u/s) a la que el clip luce natural a timeScale 1. 0 = no depende de la velocidad. */
  refSpeed: number;
  /** timeScale base (p.ej. 0.5 cuando `walk` se deriva reproduciendo `run` a media velocidad). */
  baseTimeScale: number;
}

/** Busca el primer clip cuyo nombre contenga `key` (case-insensitive, difuso). */
function findClip(clips: THREE.AnimationClip[], key: string): THREE.AnimationClip | undefined {
  return clips.find((c) => c.name.toLowerCase().includes(key));
}

/**
 * Conduce un `AnimationMixer` eligiendo idle/walk/run/jump por el estado de
 * movimiento y haciendo crossfade de 0.2 s. Tolera sets de clips incompletos:
 *
 *  - Nombres difusos: mapea por `includes` (Tripo exporta nombres variados:
 *    "Armature|Walk", "mixamo.com", "Run_01", ...).
 *  - Degradación con gracia:
 *      · sin `idle` → usa el primer clip disponible como reposo.
 *      · sin `walk` → reproduce `run` a media velocidad (baseTimeScale 0.5).
 *      · sin `run`  → reproduce `walk` acelerado.
 *      · sin `jump` → cae en cascada a run → walk → idle.
 *  - Sincronía de pasos: para walk/run ajusta `timeScale` con la velocidad real
 *    para reducir el patinaje de pies.
 */
export class AnimationDriver {
  private actions: Partial<Record<Locomotion, Resolved>> = {};
  private current?: Locomotion;

  constructor(
    private mixer: THREE.AnimationMixer,
    clips: THREE.AnimationClip[],
    opts?: { walkRefSpeed?: number; runRefSpeed?: number },
  ) {
    const walkRef = opts?.walkRefSpeed ?? 1.6;
    const runRef = opts?.runRefSpeed ?? 4.5;

    const idle = findClip(clips, "idle") ?? clips[0];
    const walk = findClip(clips, "walk");
    const run = findClip(clips, "run");
    const jump = findClip(clips, "jump");

    if (idle) {
      this.actions.idle = { action: this.mixer.clipAction(idle), refSpeed: 0, baseTimeScale: 1 };
    }

    // walk: walk real | run a media velocidad | idle.
    if (walk) this.actions.walk = { action: this.mixer.clipAction(walk), refSpeed: walkRef, baseTimeScale: 1 };
    else if (run) this.actions.walk = { action: this.mixer.clipAction(run), refSpeed: walkRef, baseTimeScale: 0.5 };
    else this.actions.walk = this.actions.idle;

    // run: run real | walk acelerado | idle.
    if (run) this.actions.run = { action: this.mixer.clipAction(run), refSpeed: runRef, baseTimeScale: 1 };
    else if (walk) this.actions.run = { action: this.mixer.clipAction(walk), refSpeed: runRef, baseTimeScale: 1 };
    else this.actions.run = this.actions.idle;

    // jump: jump real | cascada run → walk → idle.
    if (jump) this.actions.jump = { action: this.mixer.clipAction(jump), refSpeed: 0, baseTimeScale: 1 };
    else this.actions.jump = this.actions.run ?? this.actions.walk ?? this.actions.idle;

    // Todas en bucle (para un placeholder es suficiente; el salto reinicia al entrar).
    for (const key of Object.keys(this.actions) as Locomotion[]) {
      const r = this.actions[key];
      if (r) {
        r.action.setLoop(THREE.LoopRepeat, Infinity);
        r.action.enabled = true;
      }
    }
  }

  update(dt: number, state: AvatarDriveState): void {
    const target = this.pick(state);
    this.play(target);

    const r = this.actions[target];
    if (r) {
      if ((target === "walk" || target === "run") && r.refSpeed > 0) {
        // Sincroniza la cadencia con la velocidad real (anti-patinaje).
        const ratio = THREE.MathUtils.clamp(state.speed / r.refSpeed, 0.4, 1.8);
        r.action.timeScale = r.baseTimeScale * ratio;
      } else {
        r.action.timeScale = r.baseTimeScale;
      }
    }

    this.mixer.update(dt);
  }

  private pick(state: AvatarDriveState): Locomotion {
    if (state.jumping) return "jump";
    const ratio = state.maxSpeed > 0 ? state.speed / state.maxSpeed : 0;
    if (ratio < 0.12) return "idle";
    if (ratio < 0.62) return "walk";
    return "run";
  }

  private play(next: Locomotion): void {
    if (next === this.current) return;
    const nextR = this.actions[next];
    if (!nextR) return;
    const prevR = this.current ? this.actions[this.current] : undefined;

    // Si el estado nuevo reutiliza el mismo AnimationAction (clip derivado por
    // fallback), no hay nada que cruzar: sólo cambia el timeScale más arriba.
    if (prevR && prevR.action === nextR.action) {
      this.current = next;
      return;
    }

    nextR.action.reset().setEffectiveWeight(1).fadeIn(FADE).play();
    if (prevR) prevR.action.fadeOut(FADE);
    this.current = next;
  }

  dispose(): void {
    this.mixer.stopAllAction();
  }
}
