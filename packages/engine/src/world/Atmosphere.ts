import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";

/**
 * Atmósfera de Paqo (la niebla LILA es PROTAGONISTA): capas de niebla baja
 * rodante sobre el claro + MAR DE NIEBLA bajo la isla (planos enormes con scroll
 * de ruido por debajo del filo) para que mirar hacia el abismo se sienta como un
 * vacío brumoso malva. Complementa el fog exp2 y la cúpula de cielo flamingo de
 * PaqoWorld. Las motas cercanas ahora las lleva PixelSwarm (píxeles interactivos).
 */
export class Atmosphere {
  readonly group = new THREE.Group();
  private fogMats: THREE.ShaderMaterial[] = [];
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private fogShells: THREE.Mesh[] = [];
  /** Opacidades base de cada capa de niebla (capturadas la 1ª vez que se escala). */
  private fogOpacityBase?: number[];

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
  ) {}

  build(): void {
    this.buildRollingFog();
    this.buildFogSea();
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
    // Comparte la REFERENCIA viva de scene.fog.color con todas las capas de niebla:
    // cuando el clima muta fog.color in place, el mar de niebla funde hacia el mismo
    // tono automáticamente (sin copia por frame) → costura continua con la cúpula.
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      for (const m of this.fogMats) m.uniforms.uFogColor.value = fog.color;
    }
  }

  /** Escala global de la densidad/opacidad del shell de niebla (1=por defecto). */
  setDensityScale(s: number): void {
    // Captura las opacidades base la primera vez (baseline = escala 1).
    if (!this.fogOpacityBase) {
      this.fogOpacityBase = this.fogMats.map((m) => m.uniforms.uOpacity.value as number);
    }
    for (let i = 0; i < this.fogMats.length; i++) {
      this.fogMats[i].uniforms.uOpacity.value = this.fogOpacityBase[i] * s;
    }
  }

  update(dt: number, t: number): void {
    for (const m of this.fogMats) m.uniforms.uTime.value = t;
    // Deriva lenta de las capas altas para que "rueden" sobre el claro.
    for (let i = 0; i < this.fogShells.length; i++) {
      this.fogShells[i].rotateOnAxis(new THREE.Vector3(0, 0, 1), dt * (0.008 + i * 0.004));
    }
  }

  // ---- material de niebla plana (scroll de fBm), reutilizable ----

  private makeFogMaterial(
    color: THREE.Color,
    opacity: number,
    scroll: number,
    seed: number,
    centerFadeR: number,
    fogDensity: number,
    edgeInner: number,
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: color },
        uOpacity: { value: opacity },
        uScroll: { value: scroll },
        uSeed: { value: seed },
        uCenterFade: { value: centerFadeR },
        // uFogColor arranca = uColor; addTo lo REEMPLAZA por la referencia viva de
        // scene.fog.color (que el clima muta in place) → el disco funde con el fog
        // vivo. uFogDensity: exp2 por distancia. uEdgeInner: inicio del edgeFade.
        uFogColor: { value: color.clone() },
        uFogDensity: { value: fogDensity },
        uEdgeInner: { value: edgeInner },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vR; varying vec3 vWorldPos;
        void main() {
          vUv = uv; vR = length(position.xy);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
        uniform float uScroll; uniform float uSeed; uniform float uCenterFade;
        uniform vec3 uFogColor; uniform float uFogDensity; uniform float uEdgeInner;
        varying vec2 vUv; varying float vR; varying vec3 vWorldPos;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
          vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
        }
        float fbm(vec2 p){
          float v=0.0, a=0.5;
          for(int k=0;k<4;k++){ v+=a*noise(p); p*=2.0; a*=0.5; }
          return v;
        }
        void main(){
          vec2 p = vUv * 4.0 + vec2(uSeed);
          float n = fbm(p + vec2(uTime * uScroll, uTime * uScroll * 0.6));
          n = smoothstep(0.35, 0.85, n);
          float centerFade = smoothstep(0.0, uCenterFade, vR);
          // edgeFade arranca en uEdgeInner (mar de niebla = 0.4: fundido largo, sin
          // línea dura contra la cúpula).
          float edgeFade = 1.0 - smoothstep(uEdgeInner, 1.0, length(vUv - 0.5) * 2.0);
          float a = n * uOpacity * centerFade * edgeFade;
          // Atenuación exp2 por DISTANCIA hacia el color de fog de la escena: el filo
          // lejano del disco converge al mismo tono que el horizonte de la cúpula
          // (uHorizon = fog) → sin costura. (cameraPosition lo inyecta three para
          // ShaderMaterial.)
          float d = length(vWorldPos - cameraPosition);
          float ff = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
          vec3 c = mix(uColor, uFogColor, ff);
          gl_FragColor = vec4(c, a);
        }
      `,
    });
  }

  // ---- capas de niebla baja rodante sobre el claro ----

  private buildRollingFog(): void {
    const layers = 3;
    const up = new THREE.Vector3(0, 1, 0);
    const groundH = this.preset.fog?.groundLayer?.height ?? 6;
    const color = new THREE.Color(this.preset.fog?.color ?? "#D8E0DE");
    for (let i = 0; i < layers; i++) {
      const geo = new THREE.CircleGeometry(70, 64);
      const height = this.field.clearLevel + 2.5 + i * (groundH / layers) + i * 1.5;
      // centerFade en unidades de posición (radio 70): funde el centro ~20 u
      // para no tapar el tótem. Niebla baja: exp2 suave (0.004) y edgeFade normal
      // (0.7) — está cerca y pequeña, sin costura contra la cúpula.
      const mat = this.makeFogMaterial(color, 0.16 - i * 0.03, 0.012 + i * 0.006, i * 3.7, 20, 0.004, 0.7);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(up).multiplyScalar(height);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.fogShells.push(mesh);
      this.fogMats.push(mat);
      this.disposables.push(geo, mat);
    }
  }

  // ---- mar de niebla bajo la isla (planos enormes en el abismo) ----

  private buildFogSea(): void {
    const layers = 3;
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color(this.preset.fog?.color ?? "#D8E0DE");
    for (let i = 0; i < layers; i++) {
      const geo = new THREE.CircleGeometry(360, 72);
      // Capa superior a -16 (justo bajo CLIFF_BOTTOM=-14): TAPA el hueco entre el
      // filo de la isla y el mar de niebla. Capas a -16/-26/-36.
      const y = -16 - i * 10;
      // Sin center-fade: el mar llena el abismo bajo la isla. Scroll amplio. exp2
      // por distancia (0.009 ≈ densidad del fog de escena) + edgeFade largo (0.4):
      // el filo lejano funde con el horizonte de la cúpula → sin línea rara.
      const mat = this.makeFogMaterial(color, 0.28 - i * 0.05, 0.02 + i * 0.008, 11 + i * 2.3, 0.01, 0.009, 0.4);
      // Fade sólo hacia el borde lejano ya lo hace edgeFade del shader.
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, y, 0);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.fogMats.push(mat);
      this.disposables.push(geo, mat);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
