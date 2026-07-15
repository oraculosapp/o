import * as THREE from "three";
import { makeToonRamp } from "../util/toon";
import type { TintZone } from "./types";

const ZONES: TintZone[] = ["primary", "secondary", "hair", "skin", "accent"];

/** Centro de hue (0..1) y ancho de banda para el enmascarado por color en modo hueMask. */
export interface HueBand {
  zone: TintZone;
  /** Hue central 0..1 (0=rojo, 0.33=verde, 0.66=azul). */
  hue: number;
  /** Media anchura de la banda de hue afectada (0..0.5). */
  range: number;
}

/**
 * Aplica tinte multiplicativo por zonas ("primary", "secondary", "hair") sobre
 * materiales toon, vía `onBeforeCompile`. Dos estrategias — se elige según lo
 * que traiga el GLB (ver AvatarRig):
 *
 *  A) **Por material/submesh** (`patchZone`) — el modelo trae varios materiales
 *     (lo habitual en Tripo3D: ropa / pelo / piel separados). Cada material se
 *     asigna a una zona y se tinta entero. Es la ruta precisa y la que usa el
 *     TestDummy (por eso el sistema es 100% testeable hoy).
 *
 *  B) **Por máscara de hue** (`patchHueMask`) — el modelo trae UN solo material
 *     con todo horneado en una textura. Se recolorea por fragmento según el hue
 *     del texel: los píxeles cuyo hue cae en la banda de una zona reciben su
 *     tinte. Best-effort; las bandas por defecto las fija AvatarRig y el
 *     integrador puede afinarlas cuando existan los modelos reales.
 *
 * En ambos casos el color de cada zona es un **multiplicador** (blanco = sin
 * cambio). Los tres uniforms de color son compartidos por referencia entre
 * todos los materiales, así `set()` actualiza todo de golpe.
 */
export class TintController {
  readonly uPrimary: THREE.IUniform<THREE.Color> = { value: new THREE.Color(1, 1, 1) };
  readonly uSecondary: THREE.IUniform<THREE.Color> = { value: new THREE.Color(1, 1, 1) };
  readonly uHair: THREE.IUniform<THREE.Color> = { value: new THREE.Color(1, 1, 1) };
  readonly uSkin: THREE.IUniform<THREE.Color> = { value: new THREE.Color(1, 1, 1) };
  readonly uAccent: THREE.IUniform<THREE.Color> = { value: new THREE.Color(1, 1, 1) };

  private uniformFor(zone: TintZone): THREE.IUniform<THREE.Color> {
    switch (zone) {
      case "primary": return this.uPrimary;
      case "secondary": return this.uSecondary;
      case "hair": return this.uHair;
      case "skin": return this.uSkin;
      case "accent": return this.uAccent;
    }
  }

  /** Estrategia A: tinta el material entero con el color de una zona. */
  patchZone(mat: THREE.Material, zone: TintZone): void {
    const uniform = this.uniformFor(zone);
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTint = uniform;
      shader.fragmentShader =
        "uniform vec3 uTint;\n" +
        shader.fragmentShader.replace(
          "#include <map_fragment>",
          "#include <map_fragment>\n  diffuseColor.rgb *= uTint;",
        );
    };
    mat.customProgramCacheKey = () => `phy-tint-zone-${zone}`;
    mat.needsUpdate = true;
  }

  /** Estrategia B: un solo material, tinte por fragmento enmascarado por hue. */
  patchHueMask(mat: THREE.Material, bands: HueBand[]): void {
    const uP = this.uPrimary;
    const uS = this.uSecondary;
    const uH = this.uHair;
    const band = (z: TintZone) => bands.find((b) => b.zone === z);
    const bP = band("primary");
    const bS = band("secondary");
    const bH = band("hair");

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTintPrimary = uP;
      shader.uniforms.uTintSecondary = uS;
      shader.uniforms.uTintHair = uH;

      const prelude = /* glsl */ `
        uniform vec3 uTintPrimary;
        uniform vec3 uTintSecondary;
        uniform vec3 uTintHair;
        float phyHue(vec3 c) {
          float mx = max(c.r, max(c.g, c.b));
          float mn = min(c.r, min(c.g, c.b));
          float d = mx - mn;
          if (d < 1e-4) return 0.0;
          float h;
          if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
          else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
          else                h = (c.r - c.g) / d + 4.0;
          return h / 6.0; // 0..1
        }
        // Peso 0..1 según cercanía (circular) del hue a un centro de banda.
        float phyBand(float h, float center, float range) {
          float dist = abs(h - center);
          dist = min(dist, 1.0 - dist); // hue es circular
          return 1.0 - smoothstep(range * 0.5, range, dist);
        }
      `;

      const apply = /* glsl */ `
        {
          float h = phyHue(diffuseColor.rgb);
          vec3 tinted = diffuseColor.rgb;
          ${bP ? `tinted = mix(tinted, tinted * uTintPrimary,   phyBand(h, ${bP.hue.toFixed(4)}, ${bP.range.toFixed(4)}));` : ""}
          ${bS ? `tinted = mix(tinted, tinted * uTintSecondary, phyBand(h, ${bS.hue.toFixed(4)}, ${bS.range.toFixed(4)}));` : ""}
          ${bH ? `tinted = mix(tinted, tinted * uTintHair,      phyBand(h, ${bH.hue.toFixed(4)}, ${bH.range.toFixed(4)}));` : ""}
          diffuseColor.rgb = tinted;
        }
      `;

      shader.fragmentShader =
        prelude +
        shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n" + apply);
    };
    mat.customProgramCacheKey = () => "phy-tint-huemask";
    mat.needsUpdate = true;
  }

  /** Fija el multiplicador de una zona (afecta a todos los materiales patchados). */
  set(zone: TintZone, color: THREE.Color): void {
    this.uniformFor(zone).value.copy(color);
  }

  /** Resetea las tres zonas a blanco (sin tinte). */
  reset(): void {
    for (const z of ZONES) this.uniformFor(z).value.setRGB(1, 1, 1);
  }
}

/**
 * Convierte un material del GLB (típicamente `MeshStandardMaterial`) a
 * `MeshToonMaterial` de 3 bandas conservando su textura difusa, normal y
 * emisivo. Preserva `skinning` implícitamente (en three r0.180 el skinning es
 * automático al asignar el material a un `SkinnedMesh`).
 */
export function toToonMaterial(src: THREE.Material, gradientMap: THREE.DataTexture): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const toon = new THREE.MeshToonMaterial({
    color: s.color ? s.color.clone() : new THREE.Color(0xffffff),
    map: s.map ?? null,
    normalMap: s.normalMap ?? null,
    emissive: s.emissive ? s.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: s.emissiveMap ?? null,
    emissiveIntensity: s.emissiveIntensity ?? 1,
    gradientMap,
    transparent: s.transparent,
    alphaTest: s.alphaTest,
    opacity: s.opacity,
    side: s.side,
  });
  toon.name = src.name;
  return toon;
}

/** Rampa toon compartida (3 bandas). Re-export para conveniencia del módulo avatar. */
export function avatarToonRamp(): THREE.DataTexture {
  return makeToonRamp();
}
