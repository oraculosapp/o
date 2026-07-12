import * as THREE from "three";
import type { BiospherePreset } from "../planet/types";

/** Estructura mínima del terreno que necesita el enjambre (posar por altura). */
interface HeightField {
  heightAt(x: number, z: number): number;
  clearLevel: number;
}

/**
 * Enjambre de PÍXELES místicos (la joya de la dirección de arte): reemplaza la
 * bruma/esporas de textura circular suave por CUADRADOS nítidos estilo píxel con
 * glow aditivo sutil, en tonos oro / rosa / lila. ~560 motas flotando con deriva
 * lenta sobre la isla.
 *
 * INTERACCIÓN mágico-magnética: el cursor (o el dedo al arrastrar) se proyecta a
 * un punto 3D del área de juego y ejerce un campo suave sobre las motas cercanas
 * — se apartan en un remolino perezoso (empuje radial + tangente) y regresan a su
 * deriva con un resorte elástico lento. Física CPU (coste despreciable con este
 * conteo): cada mota integra un offset de resorte que vuelve a cero cuando el
 * puntero se aleja. Sin texturas, sin passes de post.
 */
export class PixelSwarm {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  private count: number;
  private base: Float32Array; // ancla de deriva por mota (x,y,z)
  private phase: Float32Array; // fase de deriva/twinkle
  private off: Float32Array; // offset de resorte por interacción (x,y,z)
  private vel: Float32Array; // velocidad del resorte (x,y,z)
  private live: THREE.BufferAttribute; // posición renderizada = base + deriva + offset

  // Parámetros del campo magnético (suaves: mágico, no frenético).
  private static readonly RADIUS = 15; // alcance del campo (u)
  private static readonly PUSH = 30; // empuje radial
  private static readonly SWIRL = 12; // remolino tangencial (perezoso)
  private static readonly SPRING = 6.5; // constante de retorno (baja = perezoso)
  private static readonly DAMP = 4.5; // amortiguación por segundo

  private _p = new THREE.Vector3();

  constructor(field: HeightField, preset: BiospherePreset, count = 560) {
    this.count = count;
    this.base = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    this.off = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    // Paleta oro / rosa / púrpura / turquesa / naranja (del preset si viene,
    // con fallback místico). El oro sigue siendo el rey de los emisivos.
    const pixelEntry = preset.particles?.find((p) => (p.colors?.length ?? 0) > 0);
    const hexes = pixelEntry?.colors ?? ["#E3B063", "#F2A6B8", "#B18BC9", "#37D6C4", "#FF9E6B"];
    const palette = hexes.map((h) => new THREE.Color(h));
    const clear = field.clearLevel;

    for (let i = 0; i < count; i++) {
      // 62% "cerca" (anillo del claro/vegetación, a poca altura); 38% "flotante"
      // (nube ancha y alta que se derrama hacia el abismo).
      const near = Math.random() < 0.62;
      const a = Math.random() * Math.PI * 2;
      let x: number, y: number, z: number;
      if (near) {
        const r = 4 + Math.random() * 22;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = field.heightAt(x, z) + 0.5 + Math.random() * 6;
      } else {
        const r = 20 + Math.random() * 55;
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        y = clear - 6 + Math.random() * 40;
      }
      this.base[i * 3] = x;
      this.base[i * 3 + 1] = y;
      this.base[i * 3 + 2] = z;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      this.phase[i] = Math.random() * Math.PI * 2;

      // Dos tamaños de píxel (pequeño mayoritario, alguno grande que brilla más).
      sizes[i] = Math.random() < 0.78 ? 2.4 : 4.6;

      const c = palette[(Math.random() * palette.length) | 0];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    this.geo = new THREE.BufferGeometry();
    this.live = new THREE.BufferAttribute(positions, 3);
    this.live.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.live);
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    this.geo.setAttribute("aPhase", new THREE.BufferAttribute(this.phase, 1));

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute vec3 aColor; attribute float aPhase;
        uniform float uTime;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vColor = aColor;
          // Parpadeo lento (twinkle) por mota.
          vAlpha = 0.5 + 0.5 * sin(uTime * 1.3 + aPhase);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Polvo FINO de píxeles: ~3-10px en pantalla a distancias de juego,
          // con clamp duro a 12px para que las motas cercanas jamás se vuelvan
          // confeti gigante tapando la escena.
          gl_PointSize = clamp(aSize * (60.0 / -mv.z), 1.5, 12.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          // Cuadrado NÍTIDO (píxel) + halo aditivo sutil alrededor.
          vec2 q = abs(gl_PointCoord - 0.5);
          float m = max(q.x, q.y);
          float core = 1.0 - step(0.30, m);      // núcleo cuadrado duro
          float glow = smoothstep(0.5, 0.28, m); // halo suave
          // Glow como sugerencia (0.12), no plasta: el píxel manda, el halo insinúa.
          float a = (core * 0.9 + glow * 0.12) * vAlpha;
          if (a < 0.01) discard;
          vec3 col = vColor * (0.7 + 0.5 * core); // el núcleo brilla más (oro canta)
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.points);
  }

  /**
   * Integra deriva + campo del puntero (si `pointer` no es null) + resorte de
   * retorno. `pointer` es el punto 3D proyectado del cursor/dedo en el área de
   * juego. Actualiza el buffer de posiciones.
   */
  update(dt: number, t: number, pointer: THREE.Vector3 | null): void {
    this.mat.uniforms.uTime.value = t;
    const R = PixelSwarm.RADIUS;
    const damp = Math.exp(-PixelSwarm.DAMP * dt); // amortiguación estable con dt variable
    const arr = this.live.array as Float32Array;

    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const ph = this.phase[i];
      // Deriva lenta orgánica.
      const dx = Math.sin(t * 0.3 + ph) * 0.6;
      const dy = Math.sin(t * 0.22 + ph * 1.3) * 0.4;
      const dz = Math.cos(t * 0.27 + ph) * 0.6;
      const driftX = this.base[k] + dx;
      const driftY = this.base[k + 1] + dy;
      const driftZ = this.base[k + 2] + dz;

      let vx = this.vel[k];
      let vy = this.vel[k + 1];
      let vz = this.vel[k + 2];
      const ox = this.off[k];
      const oy = this.off[k + 1];
      const oz = this.off[k + 2];

      if (pointer) {
        // Posición viva actual y vector desde el puntero.
        const lx = driftX + ox - pointer.x;
        const ly = driftY + oy - pointer.y;
        const lz = driftZ + oz - pointer.z;
        const dist = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-4;
        if (dist < R) {
          const f = 1 - dist / R; // falloff radial suave
          const inv = 1 / dist;
          // Empuje radial: se aparta del puntero.
          vx += lx * inv * f * PixelSwarm.PUSH * dt;
          vy += ly * inv * f * PixelSwarm.PUSH * dt;
          vz += lz * inv * f * PixelSwarm.PUSH * dt;
          // Remolino perezoso alrededor del eje vertical (tangente en XZ).
          const tx = -lz * inv;
          const tz = lx * inv;
          vx += tx * f * PixelSwarm.SWIRL * dt;
          vz += tz * f * PixelSwarm.SWIRL * dt;
        }
      }

      // Resorte de retorno del offset a cero (elástico lento).
      vx += -ox * PixelSwarm.SPRING * dt;
      vy += -oy * PixelSwarm.SPRING * dt;
      vz += -oz * PixelSwarm.SPRING * dt;
      vx *= damp;
      vy *= damp;
      vz *= damp;

      const nox = ox + vx * dt;
      const noy = oy + vy * dt;
      const noz = oz + vz * dt;
      this.off[k] = nox;
      this.off[k + 1] = noy;
      this.off[k + 2] = noz;
      this.vel[k] = vx;
      this.vel[k + 1] = vy;
      this.vel[k + 2] = vz;

      arr[k] = driftX + nox;
      arr[k + 1] = driftY + noy;
      arr[k + 2] = driftZ + noz;
    }
    this.live.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
