import * as THREE from "three";
import type { PlanetField } from "../planet/PlanetField";
import type { BiospherePreset } from "../planet/types";
import { makeSoftCircleTexture } from "../util/toon";

/**
 * Atmósfera de Paqo (la niebla es PROTAGONISTA en la ficha): capas de niebla
 * baja rodante (planos tangentes enormes con scroll de ruido sutil cerca del
 * suelo) + esporas/polen lentas cerca de la vegetación. Complementa el fog
 * exp2 y la cúpula de cielo que ya arma PaqoWorld.
 */
export class Atmosphere {
  readonly group = new THREE.Group();
  private fogMats: THREE.ShaderMaterial[] = [];
  private sporeMat?: THREE.ShaderMaterial;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private fogShells: THREE.Mesh[] = [];
  private readonly R: number;

  constructor(
    private field: PlanetField,
    private preset: BiospherePreset,
  ) {
    this.R = field.radius;
  }

  build(): void {
    this.buildRollingFog();
    this.buildSpores();
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(dt: number, t: number): void {
    for (const m of this.fogMats) m.uniforms.uTime.value = t;
    if (this.sporeMat) this.sporeMat.uniforms.uTime.value = t;
    // Deriva lenta de las capas para que "rueden" sobre el claro.
    for (let i = 0; i < this.fogShells.length; i++) {
      this.fogShells[i].rotateOnAxis(new THREE.Vector3(0, 0, 1), dt * (0.008 + i * 0.004));
    }
  }

  // ---- capas de niebla baja rodante ----

  private buildRollingFog(): void {
    const layers = 3;
    const up = new THREE.Vector3(0, 1, 0);
    const groundH = this.preset.fog?.groundLayer?.height ?? 6;
    const color = new THREE.Color(this.preset.fog?.color ?? "#D8E0DE");
    for (let i = 0; i < layers; i++) {
      const geo = new THREE.CircleGeometry(70, 64);
      const height = 2.5 + i * (groundH / layers) + i * 1.5;
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: color },
          uOpacity: { value: 0.16 - i * 0.03 },
          uScroll: { value: 0.012 + i * 0.006 },
          uSeed: { value: i * 3.7 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying float vR;
          void main() {
            vUv = uv; vR = length(position.xy) / 70.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
          uniform float uScroll; uniform float uSeed;
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
            // Se desvanece en el centro (para no tapar el tótem) y en el borde.
            float centerFade = smoothstep(0.06, 0.28, vR);
            float edgeFade = 1.0 - smoothstep(0.7, 1.0, vR);
            float a = n * uOpacity * centerFade * edgeFade;
            gl_FragColor = vec4(uColor, a);
          }
        `,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(up).multiplyScalar(this.R + height);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.fogShells.push(mesh);
      this.fogMats.push(mat);
      this.disposables.push(geo, mat);
    }
  }

  // ---- esporas / polen lentas cerca de la vegetación ----

  private buildSpores(): void {
    const count = 380;
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const up = new THREE.Vector3(0, 1, 0);
    const d = new THREE.Vector3();
    const t = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i < count; i++) {
      // Casquete alrededor del claro (donde vive la vegetación), a poca altura.
      const angle = 0.08 + Math.random() * (22 / this.R);
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sin(angle);
      d.set(s * Math.cos(phi), Math.cos(angle), s * Math.sin(phi)).normalize();
      const h = this.field.heightAt(d);
      const lift = 0.5 + Math.random() * 4.5;
      const r = this.R + h + lift;
      positions[i * 3] = d.x * r;
      positions[i * 3 + 1] = d.y * r;
      positions[i * 3 + 2] = d.z * r;
      phases[i] = Math.random() * Math.PI * 2;
    }
    void up;
    void t;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    const tex = makeSoftCircleTexture("rgba(232,236,234,0.9)");
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uTex: { value: tex },
        uColor: { value: new THREE.Color(this.preset.palette?.secondary ?? "#8FA98C") },
      },
      vertexShader: /* glsl */ `
        attribute float aPhase; uniform float uTime; varying float vA;
        void main(){
          vec3 p = position;
          // Deriva circular lenta + bob vertical (polen flotando).
          float s = sin(uTime * 0.25 + aPhase);
          float c = cos(uTime * 0.2 + aPhase);
          p += vec3(c, s * 0.6, s) * 0.7;
          vA = 0.35 + 0.35 * (0.5 + 0.5 * sin(uTime * 0.5 + aPhase));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = 6.0 * (60.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform vec3 uColor; varying float vA;
        void main(){
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(uColor, t.a * vA);
        }
      `,
    });
    this.sporeMat = mat;
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.disposables.push(geo, mat, tex);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
