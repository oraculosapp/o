import * as THREE from "three";
import type { PlanetField } from "../planet/PlanetField";
import type { BiospherePreset } from "../planet/types";

/**
 * Agua estilizada de Paqo (S2): laguna glaciar en una cuenca REAL del terreno
 * (elegida muestreando heightAt para hallar la zona baja), arroyo que baja por
 * un meridiano hasta ella, y una cascada-hilo en la ladera. Material toon plano
 * translúcido color glaciar con franja de espuma animada por scroll de ruido —
 * sin reflejos ni refracción (fuera de presupuesto en S2).
 */
export class Water {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly R: number;

  /** Dir de la cuenca (para anclar spray de cascada desde Atmosphere si hace falta). */
  basinDir = new THREE.Vector3(0, 1, 0);
  waterfallTop = new THREE.Vector3();

  constructor(
    private field: PlanetField,
    private preset: BiospherePreset,
  ) {
    this.R = field.radius;
  }

  build(): void {
    const basin = this.findBasin();
    this.basinDir.copy(basin.dir);
    this.buildLagoon(basin);
    this.buildStream(basin);
    this.buildWaterfall(basin);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  update(_dt: number, t: number): void {
    for (const m of this.mats) m.uniforms.uTime.value = t;
  }

  // ---- localizar la cuenca más baja fuera del claro (banda del anfiteatro exterior) ----

  private findBasin(): { dir: THREE.Vector3; level: number; angle: number } {
    let best = { dir: new THREE.Vector3(0, 1, 0), level: Infinity, angle: 0.5 };
    const d = new THREE.Vector3();
    for (let ai = 0; ai < 6; ai++) {
      const angle = 0.42 + (ai / 5) * 0.18; // ~17..24 u de arco (ladera exterior)
      for (let pi = 0; pi < 72; pi++) {
        const phi = (pi / 72) * Math.PI * 2;
        this.dirAt(angle, phi, d);
        const h = this.field.heightAt(d);
        if (h < best.level) best = { dir: d.clone(), level: h, angle };
      }
    }
    return best;
  }

  /** Dirección a `angle` (rad) del polo +Y y azimut `phi`. */
  private dirAt(angle: number, phi: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = Math.sin(angle);
    return out.set(s * Math.cos(phi), Math.cos(angle), s * Math.sin(phi)).normalize();
  }

  // ---- laguna ----

  private buildLagoon(basin: { dir: THREE.Vector3; angle: number }): void {
    const radius = 5.5;
    // Nivel del agua = mínimo del terreno en la huella (charca pozada, orillas altas).
    const center = basin.dir.clone();
    const up = center.clone();
    // Base ortonormal tangente.
    const t = Math.abs(up.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const ex = new THREE.Vector3().crossVectors(t, up).normalize();
    const ez = new THREE.Vector3().crossVectors(up, ex);

    let level = Infinity;
    const probe = new THREE.Vector3();
    const angRadius = radius / this.R;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      probe
        .copy(up)
        .addScaledVector(ex, Math.cos(a) * angRadius)
        .addScaledVector(ez, Math.sin(a) * angRadius)
        .normalize();
      level = Math.min(level, this.field.heightAt(probe));
    }
    level -= 0.15;

    const geo = new THREE.CircleGeometry(radius, 48);
    const mat = this.makeWaterMaterial(0); // modo laguna: espuma en la orilla
    const mesh = new THREE.Mesh(geo, mat);
    // Plano tangente en la superficie de la cuenca, a la altura del agua.
    const pos = up.clone().multiplyScalar(this.R + level);
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);
  }

  // ---- arroyo: cinta a lo largo del meridiano claro→cuenca ----

  private buildStream(basin: { dir: THREE.Vector3; angle: number }): void {
    const startAngle = 0.30; // justo fuera del claro
    const endAngle = basin.angle - 0.02;
    const startDir = this.slerpDir(this.axis, basin.dir, startAngle / basin.angle);
    void startDir;

    const segments = 40;
    const width = 1.6;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const p = new THREE.Vector3();
    const nextP = new THREE.Vector3();
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const nextDir = new THREE.Vector3();

    for (let i = 0; i <= segments; i++) {
      const a = startAngle + ((endAngle - startAngle) * i) / segments;
      this.dirAlongMeridian(basin.dir, a, dir);
      this.field.surfacePoint(dir, p).addScaledVector(dir, 0.08);
      // Tangente de avance (hacia el siguiente punto) para orientar el ancho.
      const a2 = a + 0.01;
      this.dirAlongMeridian(basin.dir, a2, nextDir);
      this.field.surfacePoint(nextDir, nextP);
      const flow = nextP.clone().sub(p).normalize();
      side.crossVectors(flow, dir).normalize(); // perpendicular tangente
      // Ligero serpenteo del cauce.
      const wob = Math.sin(i * 0.6) * 0.5;
      const half = width * (0.7 + 0.3 * Math.sin(i * 0.3));
      const c = p.clone().addScaledVector(side, wob);
      const left = c.clone().addScaledVector(side, -half);
      const right = c.clone().addScaledVector(side, half);
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
    const mat = this.makeWaterMaterial(1); // modo arroyo: espuma que baja
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);
  }

  // ---- cascada-hilo en la ladera del anfiteatro sobre el arroyo ----

  private buildWaterfall(basin: { dir: THREE.Vector3; angle: number }): void {
    const topAngle = 0.26;
    const dirTop = this.dirAlongMeridian(basin.dir, topAngle, new THREE.Vector3());
    const dirBot = this.dirAlongMeridian(basin.dir, 0.34, new THREE.Vector3());
    const top = this.field.surfacePoint(dirTop).addScaledVector(dirTop, 0.1);
    const bot = this.field.surfacePoint(dirBot).addScaledVector(dirBot, 0.1);
    this.waterfallTop.copy(top);

    const height = top.distanceTo(bot) + 1.5;
    const geo = new THREE.PlaneGeometry(0.9, height);
    const mat = this.makeWaterMaterial(2); // modo cascada: scroll vertical
    const mesh = new THREE.Mesh(geo, mat);
    const mid = top.clone().add(bot).multiplyScalar(0.5);
    mesh.position.copy(mid);
    // Orienta el plano: up = a lo largo de la caída, cara hacia afuera (dir).
    const fall = bot.clone().sub(top).normalize();
    const face = dirTop.clone();
    const right = new THREE.Vector3().crossVectors(fall, face).normalize();
    const m = new THREE.Matrix4().makeBasis(right, fall.clone().negate(), face);
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
        uFoam: { value: new THREE.Color(0xffffff) },
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
            // Laguna: franja de espuma en la orilla (borde del disco) + ondas suaves.
            float edge = smoothstep(0.62, 0.98, length(vUv - 0.5) * 2.0);
            float n = noise(vUv * 9.0 + uTime * 0.25);
            foam = edge * (0.5 + 0.5 * n);
            col += 0.04 * noise(vUv * 6.0 - uTime * 0.15);
          } else if (uMode == 1) {
            // Arroyo: espuma que baja (scroll en v) con bandas de ruido.
            float n = noise(vec2(vUv.x * 5.0, vUv.y * 10.0 - uTime * 0.9));
            float bank = smoothstep(0.32, 0.0, abs(vUv.x - 0.5));
            foam = smoothstep(0.55, 0.9, n) * 0.8 + (1.0 - bank) * 0.4;
          } else {
            // Cascada: hilos verticales rápidos.
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

  // ---- utilidades de dirección ----

  /** Interpola por slerp entre dos direcciones (t en [0,1]). */
  private slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
    const qa = new THREE.Quaternion();
    const out = a.clone();
    const ang = a.angleTo(b);
    if (ang < 1e-5) return out;
    const axis = new THREE.Vector3().crossVectors(a, b).normalize();
    qa.setFromAxisAngle(axis, ang * t);
    return out.applyQuaternion(qa).normalize();
  }

  /** Dirección sobre el meridiano polo→cuenca a un ángulo dado desde el polo. */
  private dirAlongMeridian(basinDir: THREE.Vector3, angle: number, out: THREE.Vector3): THREE.Vector3 {
    const totalAng = this.axis.angleTo(basinDir);
    if (totalAng < 1e-5) return out.copy(this.axis);
    const axis = new THREE.Vector3().crossVectors(this.axis, basinDir).normalize();
    return out
      .copy(this.axis)
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, angle))
      .normalize();
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
