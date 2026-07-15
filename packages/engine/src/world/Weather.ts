import * as THREE from "three";
import type { BiospherePreset } from "../planet/types";

/**
 * Weather — sistema de CLIMA de la biósfera (equipo Atmos).
 *
 * El {@link WeatherDirector} orquesta transiciones de clima (pradera soleada,
 * bruma, ocaso, cenit, tormenta) modulando por igual la niebla, el gradiente de
 * cielo, las luces key/hemisférica y — vía callbacks — el viento de la vegetación
 * y la densidad del "shell" de niebla de la atmósfera. Cambiar de clima hace un
 * fundido suave (smoothstep, no un corte).
 *
 * Al construirse CAPTURA el estado baseline vivo de la escena, de modo que el
 * clima "pradera" regresa EXACTO al punto de partida (los objetivos de cada
 * preset se derivan de ese baseline capturado).
 *
 * NOTA: módulo del engine — NO importa React.
 */

/** Identificadores de los climas disponibles. */
export const WEATHER_IDS = ["pradera", "bruma", "ocaso", "cenit", "tormenta"] as const;

/** Id de un clima válido (unión literal derivada de {@link WEATHER_IDS}). */
export type WeatherId = (typeof WEATHER_IDS)[number];

/**
 * Uniforms del ShaderMaterial de la cúpula de cielo alienígena que el clima
 * modula. Es un SUBCONJUNTO estructural: el material real tiene más uniforms
 * (uTime, uSunDir, uSunColor, uCloudColor…) que el clima NO toca. Sólo se listan
 * aquí los que el director interpola/escribe.
 */
export interface SkyUniforms {
  /** Cénit del gradiente (scene.background lo SIGUE = mismo color). */
  top: { value: THREE.Color };
  /** Horizonte del gradiente. */
  bottom: { value: THREE.Color };
  /** Brillo del disco/halo del sol (bruma → pálido, cenit → alto, tormenta → oculto). */
  uSunTint: { value: number };
  /** Opacidad de las lunas (tormenta las oculta tras el cielo pizarra). */
  uMoonOpacity: { value: number };
  /** Cobertura/opacidad de las nubes fBm (bruma/tormenta → más; cenit → menos). */
  uCloud: { value: number };
  /** Intensidad de las estrellas del cénit (día luminoso → 0). */
  uStar: { value: number };
  /** Color de la banda de fusión del horizonte: lo SIGUE el color de fog vivo. */
  uHorizon: { value: THREE.Color };
  /** Visibilidad del planeta gaseoso (bruma lo atenúa, tormenta lo oculta). */
  uPlanet: { value: number };
}

/**
 * Referencias vivas de la escena que el director de clima modula. Las provee
 * PaqoWorld al construirlo (todas apuntan a objetos ya creados en initScene/start).
 */
export interface WeatherRefs {
  /** Escena; `scene.fog` es una `THREE.FogExp2` (color/densidad modulables). */
  scene: THREE.Scene;
  /** Uniforms del ShaderMaterial de la cúpula de cielo (gradiente + sol/lunas/nubes). */
  skyUniforms: SkyUniforms;
  /** Luz direccional key (sol): color/intensidad/ángulo. */
  keyLight: THREE.DirectionalLight;
  /** Luz hemisférica (rebote cielo/suelo). */
  hemiLight: THREE.HemisphereLight;
  /** Escala de viento → Vegetation.setWindScale (equipo Flora). */
  setWindScale: (s: number) => void;
  /** Escala de densidad del shell de niebla → Atmosphere.setDensityScale (equipo Atmos). */
  setFogShellScale: (s: number) => void;
}

// ─── KNOBS (ajustables) ──────────────────────────────────────────────────────

/** Duración por defecto del fundido de clima (s). */
const DEFAULT_FADE = 3;

// ─── modelo de estado ────────────────────────────────────────────────────────

/**
 * Snapshot completo de las magnitudes que el clima modula. Las de color son
 * `THREE.Color` propias (clones), nunca alias de las refs de la escena.
 */
interface WeatherState {
  fogColor: THREE.Color;
  fogDensity: number;
  /** Top del gradiente de cielo (scene.background lo SIGUE = mismo color). */
  skyTop: THREE.Color;
  skyBottom: THREE.Color;
  keyColor: THREE.Color;
  keyIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  windScale: number;
  fogShellScale: number;
  // --- cielo alienígena (skydome): magnitudes escalares del sol/lunas/nubes ---
  sunTint: number;
  moonOpacity: number;
  cloud: number;
  star: number;
  planet: number;
}

function cloneState(s: WeatherState): WeatherState {
  return {
    fogColor: s.fogColor.clone(),
    fogDensity: s.fogDensity,
    skyTop: s.skyTop.clone(),
    skyBottom: s.skyBottom.clone(),
    keyColor: s.keyColor.clone(),
    keyIntensity: s.keyIntensity,
    hemiSky: s.hemiSky.clone(),
    hemiGround: s.hemiGround.clone(),
    hemiIntensity: s.hemiIntensity,
    windScale: s.windScale,
    fogShellScale: s.fogShellScale,
    sunTint: s.sunTint,
    moonOpacity: s.moonOpacity,
    cloud: s.cloud,
    star: s.star,
    planet: s.planet,
  };
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/**
 * Orquestador del clima. Guarda el baseline capturado, deriva un objetivo por
 * preset y hace un tween suave (smoothstep) escribiendo cada frame en las refs.
 */
export class WeatherDirector {
  /** Estado baseline EXACTO capturado al construir (destino de "pradera"). */
  private readonly base: WeatherState;
  /** Objetivos por clima, derivados del baseline. */
  private readonly presets: Record<WeatherId, WeatherState>;

  /** Snapshot desde el que arranca el fundido en curso. */
  private from: WeatherState;
  /** Snapshot objetivo del fundido en curso. */
  private to: WeatherState;
  private targetId: WeatherId = "pradera";

  private t = 1; // progreso del fundido [0,1] (1 = asentado)
  private dur = DEFAULT_FADE;
  private disposed = false;

  constructor(
    private refs: WeatherRefs,
    private preset: BiospherePreset,
  ) {
    this.base = this.captureBaseline();
    this.presets = this.buildPresets(this.base);
    this.from = cloneState(this.base);
    this.to = cloneState(this.base);
  }

  /** Lee el estado vivo actual de la escena como baseline de "pradera". */
  private captureBaseline(): WeatherState {
    const { scene, skyUniforms, keyLight, hemiLight } = this.refs;
    const fog = scene.fog as THREE.FogExp2 | null;
    return {
      fogColor: fog ? fog.color.clone() : new THREE.Color("#B18BC9"),
      fogDensity: fog ? fog.density : 0.0085,
      skyTop: skyUniforms.top.value.clone(),
      skyBottom: skyUniforms.bottom.value.clone(),
      keyColor: keyLight.color.clone(),
      keyIntensity: keyLight.intensity,
      hemiSky: hemiLight.color.clone(),
      hemiGround: hemiLight.groundColor.clone(),
      hemiIntensity: hemiLight.intensity,
      windScale: 1,
      fogShellScale: 1,
      // Baseline del cielo vivo (init = 1s en PaqoWorld.initScene).
      sunTint: skyUniforms.uSunTint.value,
      moonOpacity: skyUniforms.uMoonOpacity.value,
      cloud: skyUniforms.uCloud.value,
      star: skyUniforms.uStar.value,
      planet: skyUniforms.uPlanet.value,
    };
  }

  /**
   * Deriva el objetivo de cada clima a partir del baseline capturado. Devuelve
   * clones independientes; "pradera" es el baseline EXACTO.
   */
  private buildPresets(base: WeatherState): Record<WeatherId, WeatherState> {
    // Helpers: parten de un clon del baseline y aplican mezclas puntuales.
    const from = (): WeatherState => cloneState(base);
    /** Mezcla `col` hacia `hex` un factor `k` (in place). */
    const toward = (col: THREE.Color, hex: string, k: number): THREE.Color =>
      col.lerp(new THREE.Color(hex), k);

    // ── pradera: baseline EXACTO ──────────────────────────────────────────
    const pradera = from();

    // ── bruma: todo se funde en malva ─────────────────────────────────────
    const bruma = from();
    toward(bruma.fogColor, "#B79CD0", 0.35); // lila algo más puro
    bruma.fogDensity = base.fogDensity * 2.2;
    bruma.fogShellScale = 1.6;
    bruma.keyIntensity = base.keyIntensity * 0.8; // −20 %
    toward(bruma.skyTop, "#B18BC9", 0.35); // cielo desaturado hacia lila
    toward(bruma.skyBottom, "#B18BC9", 0.42);
    toward(bruma.hemiSky, "#B18BC9", 0.18);
    bruma.windScale = 0.8;
    // Cielo: sol PÁLIDO tras la bruma, más nubes, lunas apenas veladas.
    bruma.sunTint = 0.45;
    bruma.cloud = 1.7;
    bruma.moonOpacity = 0.4;
    bruma.star = 0.2;
    bruma.planet = 0.4; // el planeta se atenúa en la bruma (atmosférico)

    // ── ocaso: horizonte naranja más profundo, luz más cálida ─────────────
    const ocaso = from();
    toward(ocaso.skyTop, "#F58A9A", 0.4); // rosa flamingo más hondo
    toward(ocaso.skyBottom, "#FF7E4A", 0.55); // naranja de horizonte profundo
    ocaso.keyColor = new THREE.Color("#FFB070");
    ocaso.keyIntensity = base.keyIntensity * 0.85; // −15 %
    toward(ocaso.hemiGround, "#3E2A5E", 0.5); // suelo más morado
    toward(ocaso.fogColor, "#C79AB0", 0.18); // niebla un pelín rosada
    ocaso.windScale = 1.0;
    // Cielo: sol bajo y cálido MUY presente; primeras estrellas y lunas visibles.
    ocaso.sunTint = 1.2;
    ocaso.cloud = 1.0;
    ocaso.moonOpacity = 0.85;
    ocaso.star = 0.5;
    ocaso.planet = 0.9; // planeta bien visible al ocaso

    // ── cenit: mediodía luminoso, aire limpio ─────────────────────────────
    const cenit = from();
    cenit.keyColor = new THREE.Color("#FFF2D8"); // key más blanca
    cenit.keyIntensity = base.keyIntensity * 1.25; // +25 %
    cenit.fogDensity = base.fogDensity * 0.6;
    cenit.fogShellScale = 0.7;
    toward(cenit.skyTop, "#FFC0C4", 0.45); // cielo más claro/luminoso
    toward(cenit.skyBottom, "#FFC290", 0.4);
    toward(cenit.hemiSky, "#FFE6D6", 0.3);
    cenit.hemiIntensity = base.hemiIntensity * 1.12;
    cenit.windScale = 0.7;
    // Cielo: SOL ALTO y brillante, aire limpio (pocas nubes), sin estrellas, lunas
    // tenues bajo el mediodía.
    cenit.sunTint = 1.5;
    cenit.cloud = 0.5;
    cenit.moonOpacity = 0.25;
    cenit.star = 0.0;
    cenit.planet = 1.0; // aire limpio: planeta nítido

    // ── tormenta: pizarra-púrpura amenazante pero LEGIBLE ─────────────────
    const tormenta = from();
    tormenta.skyTop = new THREE.Color("#6E5A8E");
    tormenta.skyBottom = new THREE.Color("#8A6E7E");
    tormenta.keyColor = new THREE.Color("#B8A8D8"); // fría
    tormenta.keyIntensity = base.keyIntensity * 0.55; // −45 %
    toward(tormenta.hemiSky, "#B7A9C4", 0.5);
    tormenta.hemiIntensity = base.hemiIntensity * 0.7; // −30 %
    toward(tormenta.fogColor, "#9B90A8", 0.5); // gris-lila
    tormenta.fogDensity = base.fogDensity * 1.5;
    tormenta.fogShellScale = 1.3;
    tormenta.windScale = 2.4;
    // Cielo pizarra cubierto: sol OCULTO, lunas OCULTAS, nubes densas, sin estrellas.
    tormenta.sunTint = 0.15;
    tormenta.cloud = 2.2;
    tormenta.moonOpacity = 0.0;
    tormenta.star = 0.0;
    tormenta.planet = 0.0; // tormenta oculta el planeta tras el cielo pizarra

    return { pradera, bruma, ocaso, cenit, tormenta };
  }

  /** Transiciona al clima `id` con un fundido de `fadeSec` segundos. */
  setWeather(id: WeatherId, fadeSec = DEFAULT_FADE): void {
    if (this.disposed) return;
    // Arranca desde el estado interpolado ACTUAL (redirección suave a mitad de
    // fundido) hacia el objetivo del preset pedido.
    this.from = this.sampleCurrent();
    this.to = cloneState(this.presets[id]);
    this.targetId = id;
    this.dur = Math.max(0, fadeSec);
    this.t = this.dur === 0 ? 1 : 0;
    if (this.t === 1) this.apply(1); // fundido instantáneo → asienta ya
  }

  /** Clima activo (objetivo actual). */
  get current(): WeatherId {
    return this.targetId;
  }

  /** Avanza la transición/animación del clima por frame. */
  update(dt: number): void {
    if (this.disposed || this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / (this.dur || 1e-6));
    const k = this.t * this.t * (3 - 2 * this.t); // smoothstep
    this.apply(k);
  }

  /**
   * Reconstruye el estado interpolado ACTUAL (mezcla from→to al progreso vivo).
   * Sirve como nuevo `from` al redirigir un fundido en curso.
   */
  private sampleCurrent(): WeatherState {
    if (this.t >= 1) return cloneState(this.to);
    const k = this.t * this.t * (3 - 2 * this.t);
    return {
      fogColor: this.from.fogColor.clone().lerp(this.to.fogColor, k),
      fogDensity: lerp(this.from.fogDensity, this.to.fogDensity, k),
      skyTop: this.from.skyTop.clone().lerp(this.to.skyTop, k),
      skyBottom: this.from.skyBottom.clone().lerp(this.to.skyBottom, k),
      keyColor: this.from.keyColor.clone().lerp(this.to.keyColor, k),
      keyIntensity: lerp(this.from.keyIntensity, this.to.keyIntensity, k),
      hemiSky: this.from.hemiSky.clone().lerp(this.to.hemiSky, k),
      hemiGround: this.from.hemiGround.clone().lerp(this.to.hemiGround, k),
      hemiIntensity: lerp(this.from.hemiIntensity, this.to.hemiIntensity, k),
      windScale: lerp(this.from.windScale, this.to.windScale, k),
      fogShellScale: lerp(this.from.fogShellScale, this.to.fogShellScale, k),
      sunTint: lerp(this.from.sunTint, this.to.sunTint, k),
      moonOpacity: lerp(this.from.moonOpacity, this.to.moonOpacity, k),
      cloud: lerp(this.from.cloud, this.to.cloud, k),
      star: lerp(this.from.star, this.to.star, k),
      planet: lerp(this.from.planet, this.to.planet, k),
    };
  }

  /** Escribe en las refs el estado from→to interpolado al factor `k` (ya suavizado). */
  private apply(k: number): void {
    const { scene, skyUniforms, keyLight, hemiLight, setWindScale, setFogShellScale } = this.refs;
    const { from, to } = this;

    // Niebla exp2.
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(from.fogColor).lerp(to.fogColor, k);
      fog.density = lerp(from.fogDensity, to.fogDensity, k);
      // La banda de fusión del horizonte del cielo SIGUE al color de fog vivo →
      // costura CONTINUA entre cúpula, mar de niebla y niebla exp2.
      skyUniforms.uHorizon.value.copy(fog.color);
    }

    // Cielo (uniforms mutados in place → el shader lee el nuevo valor).
    skyUniforms.top.value.copy(from.skyTop).lerp(to.skyTop, k);
    skyUniforms.bottom.value.copy(from.skyBottom).lerp(to.skyBottom, k);
    // Sol/lunas/nubes/estrellas del skydome alienígena.
    skyUniforms.uSunTint.value = lerp(from.sunTint, to.sunTint, k);
    skyUniforms.uMoonOpacity.value = lerp(from.moonOpacity, to.moonOpacity, k);
    skyUniforms.uCloud.value = lerp(from.cloud, to.cloud, k);
    skyUniforms.uStar.value = lerp(from.star, to.star, k);
    skyUniforms.uPlanet.value = lerp(from.planet, to.planet, k);

    // scene.background SIGUE al top del cielo (mismo color).
    const bg = scene.background as THREE.Color | null;
    if (bg && (bg as THREE.Color).isColor) bg.copy(skyUniforms.top.value);
    else scene.background = skyUniforms.top.value.clone();

    // Luces.
    keyLight.color.copy(from.keyColor).lerp(to.keyColor, k);
    keyLight.intensity = lerp(from.keyIntensity, to.keyIntensity, k);
    hemiLight.color.copy(from.hemiSky).lerp(to.hemiSky, k);
    hemiLight.groundColor.copy(from.hemiGround).lerp(to.hemiGround, k);
    hemiLight.intensity = lerp(from.hemiIntensity, to.hemiIntensity, k);

    // Callbacks a otros equipos (viento de la flora, shell de niebla).
    setWindScale(lerp(from.windScale, to.windScale, k));
    setFogShellScale(lerp(from.fogShellScale, to.fogShellScale, k));
  }

  /** Libera cualquier recurso propio del director (no posee GPU; sólo se apaga). */
  dispose(): void {
    this.disposed = true;
  }
}
