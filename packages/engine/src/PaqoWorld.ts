import * as THREE from "three";
import { Island } from "./island/Island";
import { CharacterController } from "./controller/CharacterController";
import { TestDummy } from "./avatar/TestDummy";
import { buildArchetype, isArchetypeId as isProceduralArchetype } from "./avatar/archetypes";
import { loadAvatarRigShared } from "./avatar/AvatarGLTFCache";
import type { AvatarConfig, TintZone } from "./avatar/types";
import { FollowCamera } from "./camera/FollowCamera";
import { InputManager } from "./input/InputManager";
import { makeToonRamp } from "./util/toon";
import { Vegetation } from "./world/Vegetation";
import { Atmosphere } from "./world/Atmosphere";
import { PixelSwarm } from "./world/PixelSwarm";
import { Totem } from "./world/Totem";
import { BloomComposer } from "./postfx/BloomComposer";
import { WorldNet } from "./net/WorldNet";
import { Soundscape } from "./audio/Soundscape";
import { WeatherDirector, type WeatherId } from "./world/Weather";
import { AmbientLife } from "./world/AmbientLife";
import { MotionTrail } from "./world/MotionTrail";
import { DrawTrail } from "./world/DrawTrail";
import { BallGame } from "./game/BallGame";
import type { MoodId } from "./postfx/MoodGrading";
import type { BiospherePreset } from "./planet/types";
import type { BallState } from "./net/types";

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

  /**
   * Input del mundo. Público para el Contrato B (UI móvil):
   * `world.input.pressJump()`, `world.input.pressGrab()`,
   * `world.input.onActionState(cb)`. Disponible tras start().
   */
  input!: InputManager;

  // Inset de viewport activo (Contrato A); se reaplica en resize.
  private viewportInset = { left: 0, right: 0, top: 0, bottom: 0 };

  private rune!: THREE.Mesh;
  private pixels!: PixelSwarm;
  private marker!: THREE.Mesh;
  private moveTarget: THREE.Vector3 | null = null;
  private markerLife = 0;

  private vegetation!: Vegetation;
  private atmosphere!: Atmosphere;
  private totem!: Totem;
  private bloom!: BloomComposer;

  // Referencias de la escena promovidas a campos para que las module el clima.
  // El skydome alienígena expone gradiente (top/bottom) + sol + lunas + nubes +
  // estrellas + banda de horizonte. El clima (Weather) sólo modula un subconjunto
  // (ver SkyUniforms); el resto son estáticos (dir/color del sol, color de nube…).
  private skyUniforms!: {
    top: { value: THREE.Color };
    bottom: { value: THREE.Color };
    uTime: { value: number };
    uSunDir: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uSunTint: { value: number };
    uMoonOpacity: { value: number };
    uCloud: { value: number };
    uCloudColor: { value: THREE.Color };
    uStar: { value: number };
    uHorizon: { value: THREE.Color };
    uPlanet: { value: number };
  };
  private keyLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;

  // ─── KNOBS de sombras (equipo Cielo, documentados) ───────────────────────────
  /** Resolución del shadow map (px). 1024 = nítido y barato en Intel UHD. */
  private static readonly SHADOW_MAP_SIZE = 1024;
  /** Semiancho (u) de la cámara orto de sombra, centrada en el área jugable. */
  private static readonly SHADOW_HALF = 35;
  /** Near/Far de la cámara orto (u desde el sol; origen ≈ a 156 u de (80,120,60)). */
  private static readonly SHADOW_NEAR = 80;
  private static readonly SHADOW_FAR = 260;
  /** Depth bias contra shadow-acne (low-poly toon = acné fácil). */
  private static readonly SHADOW_BIAS = -0.0006;
  /** Normal bias (u): empuja la muestra por la normal — clave en caras planas grandes. */
  private static readonly SHADOW_NORMAL_BIAS = 0.12;
  /** Tope de instancias para proyectar sombra: InstancedMesh con menos que esto
   *  (árboles/copas/rocas/menhires/matas/helechos/flores) castea; los anillos de
   *  pasto (miles) NO, para no saturar el shadow map. */
  private static readonly SHADOW_INSTANCE_MAX = 400;

  /** Director de clima (fog/cielo/luces/viento). Disponible tras start(). */
  private weather!: WeatherDirector;
  /** Vida ambiente (mariposas/semillas). Disponible tras start(). */
  private ambientLife!: AmbientLife;

  /** Estela de partículas compartida (jugador local + remotos). Tras start(). */
  private motionTrail!: MotionTrail;
  /** Modo DIBUJAR: estela arcoíris persistente. Tras start(). */
  private drawTrail!: DrawTrail;
  /** Acumulador de cadencia de la estela del jugador local (s). */
  private trailAcc = 0;

  /** Mini-juego ¡Dale a Paqo! Público (como `net`): la red programa contra él. */
  game!: BallGame;

  /** Audio procedural (WebAudio 100% sintético). Disponible tras start(). */
  private soundscape!: Soundscape;

  // Fundido de caída al vacío → respawn contemplativo.
  private fade!: HTMLDivElement;
  private fadePhase: "none" | "in" | "out" = "none";
  private fadeAmt = 0;

  private rafId = 0;
  private disposed = false;
  private resizeObs?: ResizeObserver;
  private lastW = 0;
  private lastH = 0;

  // Accesibilidad: movimiento reducido (media query + override de UI).
  private reducedMotion = false;
  private reducedMq?: MediaQueryList;

  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _worldDir = new THREE.Vector3();
  private _lookDir = new THREE.Vector3();
  private _ray = new THREE.Raycaster();
  private _ndc = new THREE.Vector2();
  private _pointerNdc = new THREE.Vector2();
  private _pointerWorld = new THREE.Vector3();
  private _hvel = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  /** Spawn a ~7 u del tótem (origen), mirándolo; laderas del anfiteatro de fondo. */
  private spawnPos = new THREE.Vector3(0, 0, 7);

  constructor(
    private container: HTMLElement,
    private preset: BiospherePreset,
    private onReady?: () => void,
    private avatarConfig?: AvatarConfig,
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
    this.enableVegetationShadows();

    // Agua RETIRADA (S5): la laguna/arroyo/cascada se eliminaron de la escena.

    this.atmosphere = new Atmosphere(this.island.field, this.preset);
    this.atmosphere.build();
    this.atmosphere.addTo(this.scene);

    // Vida ambiente (mariposas/semillas — equipo Flora). Stub no-op por ahora.
    this.ambientLife = new AmbientLife(this.island.field, this.preset);
    this.ambientLife.build();
    this.ambientLife.addTo(this.scene);

    // Enjambre de píxeles interactivos (oro/rosa/lila) — reemplaza bruma/esporas.
    this.pixels = new PixelSwarm(this.island.field, this.preset);
    this.pixels.addTo(this.scene);

    // [VUELO/MANDOS] Estela de partículas compartida (local + remotos, 1 draw call)
    // y modo DIBUJAR (estela arcoíris persistente). Se construyen antes de la red
    // para inyectar la estela como pool compartido de los remotos.
    this.motionTrail = new MotionTrail();
    this.motionTrail.addTo(this.scene);
    this.drawTrail = new DrawTrail();
    this.drawTrail.addTo(this.scene);

    // Arranca SIEMPRE con el maniquí (mundo vivo al instante). Si hay un
    // arquetipo elegido, se carga en segundo plano y sustituye al maniquí; si el
    // GLB no existe aún, se queda el maniquí (con su tinte). Cambiar de avatar en
    // caliente pasa por el mismo camino (setAvatar).
    this.rig = new TestDummy();
    this.controller = new CharacterController(this.island, this.spawnPos, this.rig);
    this.controller.onVoidFall = () => this.beginFall();
    // [EQUIPO TIERRA] copas de árbol pisables: la vegetación aporta alturas extra.
    this.controller.addHeightProvider((x, z) => this.vegetation.platformHeightAt(x, z));
    this.controller.addTo(this.scene);
    this.enableAvatarShadows();
    this.controller.faceToward(this.rune.position);
    if (this.avatarConfig) this.setAvatar(this.avatarConfig);

    // La cámara recibe el campo de altura para el clamp anti-suelo al mirar arriba.
    this.follow = new FollowCamera(this.camera, this.controller, this.island.field);
    this.follow.snapBehind();

    // Accesibilidad: respeta prefers-reduced-motion (y el override de UI por
    // localStorage). Reevalúa en caliente si cambia el media query o la clave.
    this.initReducedMotion();

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
      playerFlying: () => this.controller.isFlying(),
      playerFeetY: () => this.controller.feetY,
      field: this.island.field,
      motionTrail: this.motionTrail, // [VUELO] estela compartida de los remotos
    });
    this.net.start();
    // [DIBUJO] Puente hacia el DrawTrail para la difusión de trazos por red.
    this.net.setDrawTrail(this.drawTrail);
    // [MANDOS] Táctil (puntero grueso): el sprite de la tecla "E" no aplica (hay
    // botón "Tomar"). Lo cableamos al media query y seguimos cambios de puntero.
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const coarseMq = window.matchMedia("(pointer: coarse)");
      this.net.setKeyHintEnabled(!coarseMq.matches);
      coarseMq.addEventListener?.("change", (e) => {
        if (!this.disposed) this.net.setKeyHintEnabled(!e.matches);
      });
    }

    // Director de clima (equipo Atmos): modula fog/cielo/luces y, vía callbacks,
    // el viento de la vegetación y la densidad del shell de niebla. Stub no-op.
    this.weather = new WeatherDirector(
      {
        scene: this.scene,
        skyUniforms: this.skyUniforms,
        keyLight: this.keyLight,
        hemiLight: this.hemiLight,
        setWindScale: (s) => this.vegetation.setWindScale(s),
        setFogShellScale: (s) => this.atmosphere.setDensityScale(s),
      },
      this.preset,
    );

    // Mini-juego ¡Dale a Paqo! (equipo Juego): usa las pelotas del net, el campo
    // de la isla, el tótem y el soundscape. No habla con la red directamente:
    // la capa de red (apps/web) programa contra `world.game`. Stub no-op.
    this.game = new BallGame({
      scene: this.scene,
      balls: this.net.ballsSystem,
      field: this.island.field,
      getTotem: () => this.totem?.group ?? null,
      onSound: (k) => this.soundscape.onGameSound(k),
    });

    // Audio procedural: cama ambiental generativa + foley + blips de UI. El
    // contexto WebAudio nace en el primer gesto (política de autoplay). Se
    // alimenta de las señales de zona (densidad de campanillas / "found") y de
    // las patadas de pelota; la locomoción se conecta cada frame en el loop.
    this.soundscape = new Soundscape();
    this.net.onZoneSignal((signal) => this.soundscape.onZoneSignal(signal));
    this.net.onBallKick((ballId: number, s: BallState) => {
      const strength = Math.min(1, Math.hypot(s.vel[0], s.vel[2]) / 8);
      this.soundscape.onBallKick(ballId, strength);
    });

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
        if (!this.disposed) {
          this.enableTotemShadows();
          this.registerTotemCollider();
          this.renderer.compile(this.scene, this.camera);
        }
        this.onReady?.();
      });
  }

  /**
   * Aplica una configuración de avatar (arquetipo + tinte). El tinte se aplica
   * de inmediato sobre el rig actual. Si hay `archetypeUrl`, intenta cargar el GLB
   * (caché compartida) y, al terminar, sustituye el rig en caliente conservando
   * la posición; si falla (404 → “aún duerme”), avisa por `onArchetypeMissing` y
   * se queda con el rig actual. Sirve tanto en el arranque como al cambiar de
   * avatar desde el selector, sin recrear el mundo.
   */
  setAvatar(cfg: AvatarConfig): void {
    this.avatarConfig = cfg;
    const colors = PaqoWorld.tintToColors(cfg.tint);
    if (colors) this.controller.getRig()?.setTint(colors);

    // Camino preferido: arquetipo PROCEDURAL por id. Instantáneo (sin red): se
    // construye el chibi rigged y se hace hot-swap conservando los pies. Los 9
    // siempre existen (son código), así que nunca cae a “aún duerme”.
    if (cfg.archetype && isProceduralArchetype(cfg.archetype)) {
      try {
        const rig = buildArchetype(cfg.archetype);
        this.controller.setRig(rig);
        if (colors) rig.setTint(colors);
        this.enableAvatarShadows(); // el rig nuevo debe proyectar sombra
        cfg.onArchetypeLoaded?.(cfg.archetype);
      } catch (err) {
        console.warn(`[avatar] no se pudo construir el arquetipo procedural ${cfg.archetype}:`, err);
      }
      return;
    }

    // Legado: GLB por URL (se conserva para modelos reales futuros).
    const url = cfg.archetypeUrl;
    if (!url) return;
    loadAvatarRigShared(url)
      .then((rig) => {
        if (this.disposed) {
          rig.dispose();
          return;
        }
        this.controller.setRig(rig);
        if (colors) rig.setTint(colors);
        this.enableAvatarShadows(); // el rig nuevo debe proyectar sombra
        cfg.onArchetypeLoaded?.(url);
      })
      .catch((err) => {
        console.warn(`[avatar] arquetipo no disponible (${url}); sigue el maniquí:`, err);
        cfg.onArchetypeMissing?.(url);
      });
  }

  /** Convierte tintes hex de la config a THREE.Color (o null si no hay ninguno). */
  private static tintToColors(
    tint?: Partial<Record<TintZone, string>>,
  ): Partial<Record<TintZone, THREE.Color>> | null {
    if (!tint) return null;
    const out: Partial<Record<TintZone, THREE.Color>> = {};
    let any = false;
    for (const zone of Object.keys(tint) as TintZone[]) {
      const hex = tint[zone];
      if (hex) {
        out[zone] = new THREE.Color(hex);
        any = true;
      }
    }
    return any ? out : null;
  }

  /** Error de anclaje al suelo (m): |pies − heightAt|. Para la métrica de QA. */
  groundError(): number {
    return this.controller.groundError();
  }

  /**
   * Contrato UI — enciende/apaga el input del juego. La UI lo apaga (false) cuando
   * el chat toma foco: el avatar deja de moverse y Space/Enter llegan al chat.
   */
  setInputEnabled(enabled: boolean): void {
    this.input?.setInputEnabled(enabled);
  }

  /** Contrato UI — aplica un "mood" de color grading (equipo Atmos). */
  setMood(id: MoodId): void {
    this.bloom?.setMood(id);
  }

  /** Contrato UI — cambia el clima de la biósfera (equipo Atmos). */
  setWeather(id: WeatherId): void {
    this.weather?.setWeather(id);
  }

  /** Contrato UI (equipo Vuelo) — activa/desactiva el modo DIBUJAR. */
  setDrawing(on: boolean): void {
    this.drawTrail?.setDrawing(on);
  }

  /** Contrato UI (equipo Vuelo) — ¿el modo DIBUJAR está activo? */
  isDrawing(): boolean {
    return this.drawTrail?.isDrawing() ?? false;
  }

  /**
   * Contrato A — recentra el encuadre en el ÁREA VISIBLE cuando el HUD ocupa
   * márgenes del lienzo (p.ej. `{ right: 360 }` para el chat en columna a la
   * derecha). Aplica `camera.setViewOffset` vía FollowCamera. Con todo en 0 vuelve
   * al comportamiento normal. Se reevalúa en resize.
   */
  setViewportInset(inset: { left?: number; right?: number; top?: number; bottom?: number }): void {
    this.viewportInset = {
      left: inset.left ?? 0,
      right: inset.right ?? 0,
      top: inset.top ?? 0,
      bottom: inset.bottom ?? 0,
    };
    const { w, h } = this.size();
    this.follow?.setViewportInset(this.viewportInset, w, h);
  }

  /**
   * Offset de vista activo de la cámara (para el smoke test del Contrato A).
   * `enabled:false` → sin inset (encuadre normal). Tras `setViewportInset({right:360})`
   * → `enabled:true` con `offsetX` desplazado (≈180 px con lienzo simétrico).
   */
  cameraViewOffset(): { enabled: boolean; offsetX: number; offsetY: number } {
    const view = (this.camera as THREE.PerspectiveCamera & { view?: { enabled: boolean; offsetX: number; offsetY: number } | null }).view;
    return {
      enabled: view?.enabled ?? false,
      offsetX: view?.offsetX ?? 0,
      offsetY: view?.offsetY ?? 0,
    };
  }

  /**
   * Estado del audio para el smoke test (handle __PAQO__): sin gesto reporta
   * `{ created:false, state:"idle" }`; tras un gesto sintético, `created:true`,
   * `state:"running"` y `persistentNodes>0`.
   */
  audioStats(): ReturnType<Soundscape["getStats"]> {
    return this.soundscape.getStats();
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
    // Sombras del sol: shadow map PCF (NO PCFSoft — más barato en Intel UHD). El
    // key DirectionalLight proyecta; el terreno recibe. Config de la cámara orto
    // en initScene. RenderPass de pmndrs las respeta sin cambios.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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

    // Cúpula de cielo ALIENÍGENA (gradiente flamingo + sol + 2-3 lunas + estrellas
    // + nubes fBm toon), todo en UN shader del domo (coste trivial). Los uniforms
    // se promueven a campo para que el director de clima module gradiente/sol/
    // lunas/nubes/estrellas. El sol vive en la dirección de la key light → sus glow
    // y disco son COHERENTES con las sombras. El horizonte funde con el color de
    // fog (uHorizon) para una costura continua con el mar de niebla.
    const skyGeo = new THREE.SphereGeometry(1000, 48, 24);
    // Dirección del sol = posición de la key light normalizada (véase abajo, (80,120,60)).
    const sunDir = new THREE.Vector3(80, 120, 60).normalize();
    this.skyUniforms = {
      top: { value: new THREE.Color(this.preset.sky.gradientTop) }, // #F79FA8 rosa flamingo
      bottom: { value: new THREE.Color(this.preset.sky.gradientBottom) }, // #FF9E6B naranja horizonte
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color("#FFE7B0") }, // disco cálido dorado
      uSunTint: { value: 1 },
      uMoonOpacity: { value: 1 },
      uCloud: { value: 1 },
      uCloudColor: { value: new THREE.Color("#FBD9DE") }, // crema-rosa
      uStar: { value: 1 },
      uHorizon: { value: new THREE.Color(this.preset.fog.color) }, // banda de fusión = fog lila
      uPlanet: { value: 1 }, // visibilidad del planeta gaseoso (bruma lo atenúa, tormenta lo oculta)
    };
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 uHorizon;
        uniform float uTime;
        uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunTint;
        uniform float uMoonOpacity;
        uniform vec3 uCloudColor; uniform float uCloud;
        uniform float uStar;
        uniform float uPlanet;
        varying vec3 vPos;

        float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
        vec2  hash22(vec2 p){ return vec2(hash21(p), hash21(p + 37.2)); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for (int k = 0; k < 3; k++){ v += a * vnoise(p); p = p * 2.03 + vec2(11.1, 17.7); a *= 0.5; }
          return v;
        }
        // Ruido celular (Worley F1): distancia al punto-feature más cercano en una
        // rejilla 3x3. Base de los cráteres procedurales de la luna protagonista.
        float worley(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float md = 1.0;
          for (int y = -1; y <= 1; y++){
            for (int x = -1; x <= 1; x++){
              vec2 g = vec2(float(x), float(y));
              vec2 o = hash22(i + g);
              vec2 r = g + o - f;
              md = min(md, dot(r, r));
            }
          }
          return sqrt(md);
        }
        // Luna menor: disco toon con terminador simple (fase) + oscurecimiento de
        // limbo (z) y moteado tenue. 'ang' = radio angular (rad); 'phase' desplaza
        // el borde luz/sombra. Setea 'alpha' por el disco (mix contra el cielo).
        vec3 moon(vec3 dir, vec3 mdir, vec3 mcol, float ang, float phase, out float alpha){
          float d = dot(dir, mdir);
          float edge = cos(ang);
          alpha = smoothstep(edge, mix(edge, 1.0, 0.04), d);
          if (alpha <= 0.0) return vec3(0.0);
          vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), mdir));
          vec3 b = cross(mdir, t);
          vec2 lp = vec2(dot(dir, t), dot(dir, b)) / sin(ang);
          float z = sqrt(max(1.0 - dot(lp, lp), 0.0));
          float lit = smoothstep(phase - 0.4, phase + 0.4, lp.x);
          float mott = 0.9 + 0.1 * vnoise(lp * 4.0);
          return mcol * mix(0.18, 1.0, lit) * mix(0.7, 1.0, z) * mott;
        }
        // Luna PROTAGONISTA: disco grande con cráteres procedurales (fbm de maria +
        // 2 octavas de Worley), terminador con banda de penumbra cálida, limbo
        // iluminado del lado del sol (rim) y halo exterior tenue (out 'halo'). Se
        // sombrea con 'sunCol' del lado 'sdir' (dirección del sol).
        vec3 bigMoon(vec3 dir, vec3 mdir, vec3 sdir, vec3 sunCol, vec3 tint,
                     float ang, float phase, out float alpha, out float halo){
          float d = dot(dir, mdir);
          float edge = cos(ang);
          halo = smoothstep(cos(ang * 2.3), edge, d);   // glow desde ~2.3x el radio
          alpha = smoothstep(edge, mix(edge, 1.0, 0.02), d);
          halo *= (1.0 - alpha);                          // anillo exterior (no bajo el disco)
          if (alpha <= 0.0) return vec3(0.0);
          vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), mdir));
          vec3 b = cross(mdir, t);
          vec2 lp = vec2(dot(dir, t), dot(dir, b)) / sin(ang);
          float r2 = dot(lp, lp);
          float z = sqrt(max(1.0 - r2, 0.0));
          // Relieve: maria (fbm) + cráteres (Worley 2 octavas): cuencas oscuras + rims claros.
          float maria = fbm(lp * 2.2 + 5.0);
          float c1 = worley(lp * 3.0 + 2.0);
          float c2 = worley(lp * 6.5 + 9.0);
          float basin = smoothstep(0.30, 0.0, c1) * 0.18 + smoothstep(0.16, 0.0, c2) * 0.08;
          float rim   = smoothstep(0.30, 0.5, c1) * (1.0 - smoothstep(0.5, 0.7, c1)) * 0.12;
          float relief = 1.0 - basin + rim - maria * 0.08;
          // Terminador con penumbra cálida (banda ancha centrada en la fase).
          float tt = clamp((lp.x - phase) / 0.7, -1.0, 1.0);
          float term = tt * 0.5 + 0.5;                    // 0 sombra → 1 luz
          float penumbra = 1.0 - abs(tt);                 // pico en el terminador
          // Limbo iluminado: borde del disco que mira al sol (proyección de sdir).
          vec2 sp = vec2(dot(sdir, t), dot(sdir, b));
          float limbRim = smoothstep(0.65, 1.0, r2) * max(dot(normalize(lp + 1e-4), normalize(sp)), 0.0);
          float shade = mix(0.12, 1.0, term) * relief * mix(0.68, 1.0, z);
          vec3 c = tint * shade;
          c += sunCol * penumbra * term * 0.10;           // banda de penumbra cálida (lado iluminado)
          c += sunCol * limbRim * 0.55;                   // limbo brillante del lado del sol
          return c;
        }
        // Planeta gigante gaseoso: disco grande con BANDAS horizontales (fbm 1D
        // estirado por latitud), paleta lila-rosa-crema, oscurecido hacia el limbo.
        vec3 planet(vec3 dir, vec3 pdir, float ang, out float alpha){
          float d = dot(dir, pdir);
          float edge = cos(ang);
          alpha = smoothstep(edge, mix(edge, 1.0, 0.05), d);
          if (alpha <= 0.0) return vec3(0.0);
          vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), pdir));
          vec3 b = cross(pdir, t);
          vec2 lp = vec2(dot(dir, t), dot(dir, b)) / sin(ang);
          float z = sqrt(max(1.0 - dot(lp, lp), 0.0));
          // Bandas: fbm 1D estirado a lo largo de la latitud (lp.y), deriva muy lenta.
          float lat = lp.y;
          float bnd = fbm(vec2(lat * 5.0, uTime * 0.0015)) + 0.4 * fbm(vec2(lat * 12.0, 3.0));
          bnd = clamp(bnd, 0.0, 1.0);
          vec3 lilac = vec3(0.70, 0.58, 0.85);
          vec3 pink  = vec3(0.96, 0.74, 0.83);
          vec3 cream = vec3(0.99, 0.94, 0.88);
          vec3 c = mix(lilac, pink, smoothstep(0.30, 0.60, bnd));
          c = mix(c, cream, smoothstep(0.62, 0.92, bnd));
          return c * mix(0.42, 1.0, z);                   // oscurecimiento de limbo
        }

        void main(){
          vec3 dir = normalize(vPos);
          float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottom, top, h);

          // Estrellas tenues cerca del cénit (parpadeo suave).
          float hi = smoothstep(0.45, 0.9, dir.y);
          vec2 sc = dir.xz / (abs(dir.y) + 0.25) * 42.0;
          float rnd = hash21(floor(sc));
          float star = step(0.986, rnd) * (0.5 + 0.5 * sin(uTime * 1.7 + rnd * 40.0));
          col += vec3(0.9, 0.92, 1.0) * star * hi * 0.5 * uStar;

          // PLANETA gigante gaseoso: disco grande y bajo en el horizonte OPUESTO al
          // sol, con bandas horizontales lila-rosa-crema. Muy tenue: se atenúa con
          // uPlanet (bruma/tormenta) y su parte baja se funde con la niebla vía la
          // banda de horizonte (abajo). Se dibuja primero → detrás de todo.
          float ap;
          vec3 pl = planet(dir, normalize(vec3(-0.78, 0.16, -0.58)), 0.24, ap);
          col = mix(col, pl, ap * uPlanet * 0.85);

          // LUNA PROTAGONISTA (grande y cercana, radio ~1.5x): cráteres, terminador
          // con penumbra cálida, limbo iluminado del lado del sol y halo exterior.
          float aBig, halo;
          vec3 big = bigMoon(dir, normalize(vec3(-0.55, 0.50, -0.62)), uSunDir, uSunColor,
                             vec3(0.93, 0.81, 0.83), 0.16, -0.15, aBig, halo);
          col += mix(vec3(0.93, 0.81, 0.83), vec3(1.0), 0.5) * halo * 0.06 * uMoonOpacity;
          col = mix(col, big, aBig * uMoonOpacity);

          // LUNAS MENORES (4): turquesa, lila, ámbar y una verdosa pálida en ÓRBITA
          // LENTA (su dirección gira con uTime — deriva perceptible en minutos).
          float orb = uTime * 0.0016;
          float co = cos(orb), so = sin(orb);
          vec3 gBase = vec3(-0.34, 0.58, 0.56);
          vec3 gDir = vec3(gBase.x * co - gBase.z * so, gBase.y, gBase.x * so + gBase.z * co);
          float a2, a3, a4, a5;
          vec3 m2 = moon(dir, normalize(vec3( 0.60, 0.72,  0.22)), vec3(0.56, 0.88, 0.84), 0.045,  0.35, a2); // turquesa
          vec3 m3 = moon(dir, normalize(vec3( 0.12, 0.86, -0.50)), vec3(0.80, 0.72, 0.91), 0.060,  0.10, a3); // lila
          vec3 m4 = moon(dir, normalize(vec3( 0.74, 0.34, -0.30)), vec3(0.96, 0.75, 0.46), 0.050, -0.30, a4); // ámbar
          vec3 m5 = moon(dir, normalize(gDir),                     vec3(0.74, 0.90, 0.72), 0.038,  0.50, a5); // verdosa (órbita)
          col = mix(col, m3, a3 * uMoonOpacity);
          col = mix(col, m2, a2 * uMoonOpacity);
          col = mix(col, m4, a4 * uMoonOpacity);
          col = mix(col, m5, a5 * uMoonOpacity);

          // Sol: halo + disco cálido en la dirección de la key light (coherente con sombras).
          float sd = dot(dir, uSunDir);
          float glow = pow(max(sd, 0.0), 8.0) * 0.12 + pow(max(sd, 0.0), 200.0) * 0.5;
          col += uSunColor * glow * uSunTint;
          float disc = smoothstep(0.9975, 0.9990, sd);
          col = mix(col, uSunColor, disc * uSunTint);

          // Nubes fBm toon (2 muestras, scroll lento), recortadas con smoothstep.
          float up = smoothstep(-0.02, 0.22, dir.y);
          vec2 cuv = dir.xz / max(dir.y + 0.30, 0.18);
          float c = fbm(cuv * 1.25 + vec2(uTime * 0.006, uTime * 0.004));
          c += 0.45 * fbm(cuv * 2.70 - vec2(uTime * 0.010, 0.0));
          float cloud = smoothstep(0.62, 0.95, c) * up * uCloud;
          vec3 cloudLit = mix(uCloudColor, top, 0.15) + uSunColor * glow * 0.3 * uSunTint;
          col = mix(col, cloudLit, clamp(cloud, 0.0, 1.0));

          // Banda de fusión con el horizonte (= color de fog): costura continua con
          // el mar de niebla y el fog exp2 de la escena.
          float band = 1.0 - smoothstep(0.0, 0.16, abs(dir.y));
          col = mix(col, uHorizon, band * 0.9);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Luz key ÁMBAR dorada cálida; rebote de cielo cálido y rebote de suelo MORADO
    // (HemisphereLight) → sombras que viran a malva sin pass extra. Preset-driven.
    const lg = this.preset.lighting ?? {};
    this.keyLight = new THREE.DirectionalLight(new THREE.Color(lg.keyColor ?? "#FFCF8A"), lg.keyIntensity ?? 1.05);
    this.keyLight.position.set(80, 120, 60);
    // El sol proyecta sombras sobre el área jugable. Cámara orto ±SHADOW_HALF
    // centrada en el origen (tótem/claro); el target por defecto (0,0,0) coincide.
    // Bias/normalBias afinados para low-poly toon (acné vs. peter-panning).
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(PaqoWorld.SHADOW_MAP_SIZE, PaqoWorld.SHADOW_MAP_SIZE);
    this.keyLight.shadow.bias = PaqoWorld.SHADOW_BIAS;
    this.keyLight.shadow.normalBias = PaqoWorld.SHADOW_NORMAL_BIAS;
    const sc = this.keyLight.shadow.camera;
    sc.left = -PaqoWorld.SHADOW_HALF;
    sc.right = PaqoWorld.SHADOW_HALF;
    sc.top = PaqoWorld.SHADOW_HALF;
    sc.bottom = -PaqoWorld.SHADOW_HALF;
    sc.near = PaqoWorld.SHADOW_NEAR;
    sc.far = PaqoWorld.SHADOW_FAR;
    sc.updateProjectionMatrix();
    this.scene.add(this.keyLight);
    // Intensidad contenida (0.78) y rebote apenas enfriado para que el atardecer
    // bañe el valle SIN lavar el alma verde del terreno. Se promueve a campo para
    // que el director de clima module color/intensidad.
    this.hemiLight = new THREE.HemisphereLight(
      new THREE.Color(lg.skyBounceColor ?? "#F2BFC4"),
      new THREE.Color(lg.ambientColor ?? "#4A3874"),
      lg.ambientIntensity ?? 0.78,
    );
    this.scene.add(this.hemiLight);
  }

  // ---- sombras (equipo Cielo): quién proyecta ----

  /**
   * Marca las mallas del avatar del jugador (grupo del controller, incluye el rig
   * actual) como proyectoras de sombra. Barato y genérico: recorre el grupo, así
   * sirve tanto al maniquí inicial como a cualquier arquetipo cargado en caliente
   * (se re-invoca desde setAvatar). El blob-shadow del controller vive fuera de
   * este grupo (se añade suelto a la escena), así que no se toca. No edita
   * CharacterController.
   */
  private enableAvatarShadows(): void {
    this.controller.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
  }

  /**
   * Activa castShadow en la vegetación BARATA de proyectar: cada InstancedMesh con
   * menos de SHADOW_INSTANCE_MAX instancias (árboles/copas/rocas/menhires/matas/
   * helechos/flores). Excluye los anillos de pasto (miles de instancias) para no
   * saturar el shadow map. NO edita Vegetation.ts (otro equipo): recorre su group.
   */
  private enableVegetationShadows(): void {
    this.vegetation.group.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count < PaqoWorld.SHADOW_INSTANCE_MAX) {
        im.castShadow = true;
      }
    });
  }

  /** Marca las mallas del tótem como proyectoras de sombra (tras cargar el GLB). */
  private enableTotemShadows(): void {
    this.totem?.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
  }

  /**
   * [COLLIDER] Registra el poste del tótem como collider cilíndrico en el controller,
   * para que el avatar no lo atraviese. Cilindro con el MISMO patrón que BallGame:
   * Box3 del group, radio = max(size.x, size.z)/2 × 0.8, centro = centro XZ del box,
   * topY = box.max.y (~8.6 u → saltar por encima prácticamente nunca). La runa del
   * suelo NO colisiona (es un mesh aparte, no del tótem: se camina sobre ella). Si el
   * GLB no cargó, el group está vacío → box vacío → no se registra nada.
   */
  private registerTotemCollider(): void {
    const g = this.totem?.group;
    if (!g) return;
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = (Math.max(size.x, size.z) / 2) * 0.8;
    this.controller.addCylinderCollider({
      x: (box.min.x + box.max.x) / 2,
      z: (box.min.z + box.max.z) / 2,
      radius,
      topY: box.max.y,
    });
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

  // ---- accesibilidad: movimiento reducido ----

  /**
   * Configura la detección de movimiento reducido y aplica el estado inicial.
   * Escucha el media query `prefers-reduced-motion` y el evento `storage` (por si
   * un toggle de UI escribe la clave `phy:reduced-motion` desde otra pestaña).
   */
  private initReducedMotion(): void {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMq.addEventListener?.("change", this.onReducedMotionChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onReducedMotionChange);
    }
    this.applyReducedMotion();
  }

  private onReducedMotionChange = (): void => {
    if (!this.disposed) this.applyReducedMotion();
  };

  /**
   * Override del equipo de UI por localStorage. Si la clave `phy:reduced-motion`
   * existe, GANA sobre el media query (permite forzar on/off desde un toggle).
   * Devuelve null si la clave no existe (→ manda el media query).
   */
  private reducedMotionOverride(): boolean | null {
    try {
      const v = window.localStorage?.getItem("phy:reduced-motion");
      if (v == null) return null;
      const s = v.trim().toLowerCase();
      return !(s === "0" || s === "false" || s === "off" || s === "no" || s === "");
    } catch {
      return null;
    }
  }

  /** Resuelve el estado efectivo: override de UI si existe, si no el media query. */
  private resolveReducedMotion(): boolean {
    const ov = this.reducedMotionOverride();
    if (ov != null) return ov;
    return this.reducedMq?.matches ?? false;
  }

  /** Propaga el estado a cámara (auto-retorno) y enjambre (deriva/puntero). */
  private applyReducedMotion(): void {
    this.reducedMotion = this.resolveReducedMotion();
    this.follow?.setAutoReturn(!this.reducedMotion);
    this.pixels?.setReducedMotion(this.reducedMotion);
    this.ambientLife?.setReducedMotion(this.reducedMotion);
  }

  // ---- click en el PROPIO avatar → emotes ----

  /** Callback de la UI cuando el tap cae sobre el avatar del jugador (abre emotes). */
  private avatarClickCb: (() => void) | null = null;

  /**
   * Registra un callback que se dispara cuando el jugador toca/clica su PROPIO
   * avatar (raycast contra `controller.object` en el handleTap). La UI lo usa para
   * abrir el menú de emotes. Pasar `null` lo desengancha.
   */
  onAvatarClick(cb: (() => void) | null): void {
    this.avatarClickCb = cb;
  }

  // ---- tap-to-move ----

  private handleTap(ndcX: number, ndcY: number): void {
    this._ndc.set(ndcX, ndcY);
    this._ray.setFromCamera(this._ndc, this.camera);
    // ¿El tap cae sobre el propio avatar? → abre emotes y NO mueve.
    if (this.avatarClickCb) {
      const onAvatar = this._ray.intersectObject(this.controller.object, true);
      if (onAvatar.length > 0) {
        this.avatarClickCb();
        return;
      }
    }
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
    // Reevalúa el inset del viewport con el nuevo tamaño (Contrato A).
    this.follow?.applyViewOffset(w, h);
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
    // [VUELO] Botón "Volar" / tecla Q: alterna el modo vuelo del controller (entrada
    // ALTERNATIVA al triple salto, que se conserva). Edge de un frame.
    if (f.fly) this.controller.toggleFly();
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

    // [VUELO] Dirección COMPLETA de la mirada (con pitch): en vuelo, "hacia donde
    // miras es hacia donde vuelas". El controller sólo la usa en modo vuelo.
    this.camera.getWorldDirection(this._lookDir);
    this.controller.update(dt, {
      worldDir: this._worldDir,
      throttle,
      run: f.run,
      jump: f.jump,
      lookDir: this._lookDir,
    });
    this.follow.update(dt);

    // E (teclado o botón móvil) CONTEXTUAL: si hay pelota agarrable/en mano →
    // agarrar/lanzar; si no → alterna el modo DIBUJAR. (Balls lleva la proximidad).
    if (f.grab) {
      if (this.net.canGrab() || this.net.isHolding()) this.net.grabOrThrow();
      else this.drawTrail.setDrawing(!this.drawTrail.isDrawing());
    }

    // Multijugador: interpola remotos, integra pelotas, evalúa zonas.
    this.net.update(dt);

    // Estado de acción para los botones móviles (Contrato B). Se empuja cada
    // frame; el InputManager notifica a los observadores sólo cuando cambia.
    this.input.setActionState({
      canGrab: this.net.canGrab(),
      holding: this.net.isHolding(),
      grounded: this.controller.isGrounded(),
      canDoubleJump: this.controller.canDoubleJump(),
      flying: this.controller.isFlying(),
    });

    // Audio: cadencia de pasos/salto/aterrizaje atada a la velocidad REAL del
    // controller, proximidad al agua para mezclar su capa, y avance de la cama
    // generativa. Todo es no-op silencioso mientras no haya habido gesto.
    const hSpeed = this.controller.getHorizVelocity(this._hvel).length();
    // Agua retirada: proximidad 0 → la capa de agua del audio queda inerte.
    this.soundscape.setWaterProximity(0);
    this.soundscape.setMotion(hSpeed, 7, this.controller.isGrounded(), dt);
    this.soundscape.update(dt);

    // [VUELO] Estela de partículas del jugador local: emite desde los pies cuando
    // se mueve rápido (>2 u/s) o SIEMPRE en vuelo. Cadencia acotada por trailAcc.
    const flyingNow = this.controller.isFlying();
    if (hSpeed > 2 || flyingNow) {
      this.trailAcc += dt;
      const feetY = this.controller.feetY;
      while (this.trailAcc >= 0.045) {
        this.trailAcc -= 0.045;
        this.motionTrail.emit(this.controller.position.x, feetY, this.controller.position.z);
      }
    } else {
      this.trailAcc = 0;
    }
    this.motionTrail.update(dt);
    // [DIBUJO] Ribbon arcoíris: añade puntos del trazo local y lo funde/reconstruye.
    this.drawTrail.update(dt, this.controller.position, this.controller.feetY, this.camera);

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
    this.ambientLife.update(dt, t);
    // Scroll de las nubes / parpadeo de estrellas del skydome (una escritura/frame).
    this.skyUniforms.uTime.value = t;
    this.weather.update(dt);
    this.game.update(dt);
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
    this.reducedMq?.removeEventListener?.("change", this.onReducedMotionChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", this.onReducedMotionChange);
    }
    this.game?.dispose();
    this.weather?.dispose();
    this.ambientLife?.dispose();
    this.motionTrail?.dispose();
    this.drawTrail?.dispose();
    this.net?.dispose();
    this.soundscape?.dispose();
    this.input?.dispose();
    this.controller?.dispose();
    this.rig?.dispose();
    this.vegetation?.dispose();
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
