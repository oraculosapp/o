import * as THREE from "three";
import type { IslandField } from "../island/IslandField";
import type { BiospherePreset } from "../planet/types";

/**
 * Agua estilizada de Paqo (isla flotante): laguna glaciar en una cuenca REAL del
 * terreno (hallada muestreando heightAt), un río que NACE en el claro y sale por
 * el paso de cañón +X hasta el filo de la isla, donde cae como CASCADA AL VACÍO
 * hacia la niebla (el money shot de la isla flotante). Material toon plano
 * translúcido con espuma animada por scroll de ruido — sin reflejos ni refracción.
 */
export class Water {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private geos: THREE.BufferGeometry[] = [];

  /** Posición de la cuenca (para anclar spray si hace falta). */
  basinPos = new THREE.Vector3();
  /** Cima de la cascada al vacío (ancla del spray de Atmosphere). */
  waterfallTop = new THREE.Vector3();

  constructor(
    private field: IslandField,
    private preset: BiospherePreset,
  ) {}

  build(): void {
    const basin = this.findBasin();
    this.basinPos.set(basin.x, this.field.heightAt(basin.x, basin.z), basin.z);
    this.buildLagoon(basin);
    this.buildRiver();
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(_dt: number, t: number): void {
    for (const m of this.mats) m.uniforms.uTime.value = t;
  }

  /**
   * Proximidad 0..1 al cuerpo de agua más cercano (laguna / río / cascada) en el
   * plano XZ, para que el audio mezcle la capa de agua por cercanía. 1 = sobre el
   * agua, 0 = a ≥9 u. Aproxima el río como el corredor +X con su meandro.
   */
  proximityAt(x: number, z: number): number {
    const dLagoon = Math.hypot(x - this.basinPos.x, z - this.basinPos.z) - 5.5;
    let dRiver = Infinity;
    if (x > 4) {
      const meander = Math.sin((x - 6) * 0.16) * 2.2; // mismo trazo que buildRiver
      dRiver = Math.abs(z - meander) - 0.8;
    }
    const dFall = Math.hypot(x - this.waterfallTop.x, z - this.waterfallTop.z) - 1.2;
    const d = Math.max(0, Math.min(dLagoon, dRiver, dFall));
    return Math.max(0, 1 - d / 9);
  }

  // ---- cuenca más baja (banda del anfiteatro exterior, fuera del paso +X) ----

  private findBasin(): { x: number; z: number } {
    let best = { x: 0, z: 22, level: Infinity };
    for (let ai = 0; ai < 6; ai++) {
      const r = 17 + (ai / 5) * 9; // 17..26 u
      for (let pi = 0; pi < 72; pi++) {
        const phi = (pi / 72) * Math.PI * 2;
        // Evita el corredor del río (±~25° de +X) para que la laguna no lo pise.
        if (Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi))) < 0.45) continue;
        const x = Math.cos(phi) * r;
        const z = Math.sin(phi) * r;
        const h = this.field.heightAt(x, z);
        if (h < best.level) best = { x, z, level: h };
      }
    }
    return best;
  }

  // ---- laguna ----

  private buildLagoon(basin: { x: number; z: number }): void {
    const radius = 5.5;
    let level = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = basin.x + Math.cos(a) * radius;
      const z = basin.z + Math.sin(a) * radius;
      level = Math.min(level, this.field.heightAt(x, z));
    }
    level -= 0.15;

    const geo = new THREE.CircleGeometry(radius, 48);
    const mat = this.makeWaterMaterial(0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(basin.x, level, basin.z);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);
  }

  // ---- río: nace en el claro, sale por el paso +X hasta el filo ----

  private buildRiver(): void {
    const rStart = 6; // manantial dentro del claro
    const edge = this.field.edgeRadiusAt(1, 0);
    const rEnd = edge - 1.5; // justo en el filo, donde vuelca al vacío

    const segments = 48;
    const width = 1.6;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const p = new THREE.Vector3();
    const flow = new THREE.Vector3();
    const side = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const pathAt = (r: number, out: THREE.Vector3): THREE.Vector3 => {
      const meander = Math.sin((r - rStart) * 0.16) * 2.2; // serpenteo en z
      const x = r;
      const z = meander;
      return out.set(x, this.field.heightAt(x, z) + 0.08, z);
    };

    for (let i = 0; i <= segments; i++) {
      const r = rStart + ((rEnd - rStart) * i) / segments;
      pathAt(r, p);
      pathAt(r + 0.3, flow).sub(p).normalize();
      side.crossVectors(flow, up).normalize();
      const half = width * (0.7 + 0.3 * Math.sin(i * 0.3));
      const left = p.clone().addScaledVector(side, -half);
      const right = p.clone().addScaledVector(side, half);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      const v = i / segments;
      uvs.push(0, v, 1, v);
      if (i < segments) {
        const b = i * 2;
        indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = this.makeWaterMaterial(1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);

    // Cascada al vacío desde el filo.
    pathAt(rEnd, p);
    this.waterfallTop.copy(p);
    this.buildWaterfall(p);
  }

  // ---- cascada al vacío: lámina vertical larga que cae del filo hacia la niebla ----

  private buildWaterfall(top: THREE.Vector3): void {
    const fallHeight = 42; // cae muy por debajo del filo, hacia el mar de niebla
    const w = 2.4;
    const geo = new THREE.PlaneGeometry(w, fallHeight);
    const mat = this.makeWaterMaterial(2);
    const mesh = new THREE.Mesh(geo, mat);
    // Radial hacia afuera (dirección +X en el filo del río) mirando al abismo.
    const outward = new THREE.Vector3(top.x, 0, top.z).normalize();
    const mid = top.clone().addScaledVector(new THREE.Vector3(0, 1, 0), -fallHeight / 2 + 0.5);
    mid.addScaledVector(outward, 0.6);
    mesh.position.copy(mid);
    const fall = new THREE.Vector3(0, -1, 0);
    const right = new THREE.Vector3().crossVectors(fall, outward).normalize();
    const m = new THREE.Matrix4().makeBasis(right, fall.clone().negate(), outward);
    mesh.quaternion.setFromRotationMatrix(m);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);
  }

  // ---- material de agua estilizada (toon plano + espuma animada) ----

  private makeWaterMaterial(mode: number): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(this.preset.water?.color ?? "#C9D2CE") },
        // Espuma blanca apenas turquesa: acento frío que chispea sobre el agua
        // malva que refleja el cielo flamingo.
        uFoam: { value: new THREE.Color(0xdcf5ee) },
        uOpacity: { value: mode === 2 ? 0.85 : 0.72 },
        uMode: { value: mode },
        uFoamAmt: { value: this.preset.water?.foam ?? 0.7 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uColor; uniform vec3 uFoam;
        uniform float uOpacity; uniform int uMode; uniform float uFoamAmt;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p);
          float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
          vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
        }
        void main(){
          vec3 col = uColor;
          float foam = 0.0;
          if (uMode == 0) {
            float edge = smoothstep(0.62, 0.98, length(vUv - 0.5) * 2.0);
            float n = noise(vUv * 9.0 + uTime * 0.25);
            foam = edge * (0.5 + 0.5 * n);
            col += 0.04 * noise(vUv * 6.0 - uTime * 0.15);
          } else if (uMode == 1) {
            float n = noise(vec2(vUv.x * 5.0, vUv.y * 10.0 - uTime * 0.9));
            float bank = smoothstep(0.32, 0.0, abs(vUv.x - 0.5));
            foam = smoothstep(0.55, 0.9, n) * 0.8 + (1.0 - bank) * 0.4;
          } else {
            float n = noise(vec2(vUv.x * 6.0, vUv.y * 3.0 - uTime * 2.2));
            foam = smoothstep(0.35, 0.9, n);
            col = mix(uColor, uFoam, 0.35);
          }
          foam *= uFoamAmt;
          col = mix(col, uFoam, clamp(foam, 0.0, 1.0));
          float alpha = uOpacity + foam * 0.25;
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
    });
    this.mats.push(mat);
    return mat;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
