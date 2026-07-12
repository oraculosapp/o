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
  }

  update(dt: number, t: number): void {
    for (const m of this.fogMats) m.uniforms.uTime.value = t;
    // Deriva lenta de las capas altas para que "rueden" sobre el claro.
    for (let i = 0; i < this.fogShells.length; i++) {
      this.fogShells[i].rotateOnAxis(new THREE.Vector3(0, 0, 1), dt * (0.008 + i * 0.004));
    }
  }

  // ---- material de niebla plana (scroll de fBm), reutilizable ----

  private makeFogMaterial(color: THREE.Color, opacity: number, scroll: number, seed: number, centerFadeR: number): THREE.ShaderMaterial {
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
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vR;
        void main() {
          vUv = uv; vR = length(position.xy);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
        uniform float uScroll; uniform float uSeed; uniform float uCenterFade;
        varying vec2 vUv; varying float vR;
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
          float edgeFade = 1.0 - smoothstep(0.7, 1.0, length(vUv - 0.5) * 2.0);
          float a = n * uOpacity * centerFade * edgeFade;
          gl_FragColor = vec4(uColor, a);
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
      // para no tapar el tótem.
      const mat = this.makeFogMaterial(color, 0.16 - i * 0.03, 0.012 + i * 0.006, i * 3.7, 20);
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
      const y = -22 - i * 8; // muy por debajo del filo (~ -22..-38)
      // Sin center-fade: el mar llena el abismo bajo la isla. Scroll amplio.
      const mat = this.makeFogMaterial(color, 0.28 - i * 0.05, 0.02 + i * 0.008, 11 + i * 2.3, 0.01);
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
