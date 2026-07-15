import * as THREE from "three";
import { AnimationDriver } from "./AnimationDriver";
import { TintController, avatarToonRamp } from "./tint";
import { addInvertedHullOutline } from "../util/toon";
import type { AvatarDriveState, IAvatarRig, PropSocket, TintZone } from "./types";

/**
 * ChibiAvatar — constructor PROCEDURAL de avatares arquetipo (cero assets).
 *
 * Generaliza {@link TestDummy}: MISMO esqueleto de 5 huesos (hips, spine, head,
 * armR, armL) y MISMOS clips generados por código (idle/walk/jump) — así todos
 * los arquetipos caminan gratis con {@link AnimationDriver} / ProceduralLocomotion,
 * sin tocar el controller. Lo que cambia de un arquetipo a otro es SÓLO la malla:
 * paleta, cuerpo (normal/ancho), pelo, pieza de cabeza, decoración (código neón,
 * estrellas, salpicaduras, filigrana… resueltas con COLOR/emisivo, no geometría) y
 * un prop opcional parentado al socket `handR`.
 *
 * Estilo de la casa: MeshToonMaterial de 3 bandas + outline inverted-hull tintado.
 * Los outlines de las partes del cuerpo son SkinnedMesh (misma piel/hueso, geo
 * expandida por normal) para que se deformen con la animación. Los props son
 * estáticos y usan el outline normal.
 *
 * Altura ~1.7u, pies en el origen (y≈0), contrato {@link IAvatarRig} intacto.
 * Tinte por zonas: `primary` = ropa principal (torso/abrigo/mangas), `secondary` =
 * ropa inferior (piernas), `hair` = pelo/barba. Piel, acentos y props sin tinte.
 */

/** Pieza de cabeza icónica del arquetipo. */
export type HeadPiece =
  | "none"
  | "gorro"
  | "boina"
  | "capucha"
  | "pelo-largo"
  | "sombrero-ala"
  | "cuello-capa";

/** Prop icónico en la mano derecha (construido low-poly). */
export type PropKind =
  | "none"
  | "pincel"
  | "baston"
  | "libro"
  | "catalejo"
  | "regadera"
  | "maletin";

/** Estilo de pelo (casquete sobre la cabeza). */
export type HairStyle = "short" | "spiky" | "long" | "bun" | "none";

/** Capa decorativa resuelta por color/emisivo sobre el torso (no geometría cara). */
export type DecalKind = "none" | "code" | "stars" | "splatter" | "filigree";

/** Paleta de un arquetipo (hex numéricos). */
export interface ChibiPalette {
  /** Piel (sin tinte). */
  skin: number;
  /** Ropa principal — zona de tinte `primary`. */
  primary: number;
  /** Ropa inferior/secundaria — zona de tinte `secondary`. */
  secondary: number;
  /** Pelo y barba — zona de tinte `hair`. */
  hair: number;
  /** Acento (metal, neón, oro, cuero) — sin tinte, puede ser emisivo. */
  accent: number;
  /** Calzado (sin tinte). Default: marrón oscuro. */
  shoes?: number;
}

/** Especificación declarativa de un arquetipo → una malla chibi. */
export interface ArchetypeSpec {
  /** Id del arquetipo (coincide con el catálogo de la app). */
  id: string;
  /** Nombre visible (para el laboratorio/splash). */
  name: string;
  palette: ChibiPalette;
  /** Silueta del cuerpo. `wide` = bodybuilder. */
  body?: "normal" | "wide";
  /** Torso desnudo (bodybuilder): el torso usa color piel + arneses de acento. */
  bareTorso?: boolean;
  hair: HairStyle;
  head: HeadPiece;
  /** Gafas: AR verde emisiva (hacker) / redondas oscuras (godines). */
  glasses?: "none" | "ar" | "round";
  beard?: boolean;
  /** Abrigo/túnica largo (silueta): añade faldón bajo el torso. */
  coat?: "none" | "long" | "robe";
  prop: PropKind;
  /** Decoración del torso resuelta por color/emisivo. */
  decal?: DecalKind;
  /** Bufanda (color) — artista. */
  scarf?: number;
  /** Broche/gema al cuello (color) — vampiro. */
  brooch?: number;
  /** Audífonos simples — hacker. */
  headphones?: boolean;
  /** Hojas/plantas sobre el sombrero de ala — dedo verde. */
  leaves?: boolean;
  /** Cuentas/colgantes (chamán). */
  charms?: boolean;
  /** Intensidad emisiva del acento (0..1): neón hacker, estrellas astrónomo. */
  glow?: number;
}

// Índices de hueso para el skinning rígido (idénticos a TestDummy).
const BONE = { hips: 0, spine: 1, head: 2, armR: 3, armL: 4 } as const;
const BONE_NAME = { hips: "hips", spine: "spine", head: "head", armR: "armR", armL: "armL" };

/** Color de la tinta del outline (sombra profunda de la rampa toon de la casa). */
const INK = 0x140f18;
/** Expansión del casco de outline a lo largo de la normal (u). */
const OUTLINE_EPS = 0.02;
/** El frente del avatar mira a −Z (convención del controller). */
const FRONT = -1;

export class ChibiAvatar implements IAvatarRig {
  readonly root = new THREE.Group();
  readonly height: number;

  private mixer: THREE.AnimationMixer;
  private driver: AnimationDriver;
  private tint = new TintController();
  private ramp = avatarToonRamp();
  private skeleton!: THREE.Skeleton;
  private meshes: THREE.SkinnedMesh[] = [];
  private ownedMaterials: THREE.Material[] = [];
  private ownedGeoms: THREE.BufferGeometry[] = [];
  private sockets!: Record<PropSocket, THREE.Object3D>;
  private inkMat: THREE.MeshBasicMaterial;
  private disposed = false;

  constructor(private spec: ArchetypeSpec) {
    this.inkMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog: true });

    const bones = this.buildSkeleton();
    this.buildBody(spec);
    this.attachProp(this.buildProp(spec.prop), "handR");

    // Bind: primero todo en el grafo con matrices de reposo al día.
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    for (const m of this.meshes) {
      m.bind(this.skeleton);
      m.frustumCulled = false;
    }

    // Altura real medida en pose de reposo (para el controller).
    const box = new THREE.Box3().setFromObject(this.root);
    const size = new THREE.Vector3();
    box.getSize(size);
    this.height = size.y;

    this.mixer = new THREE.AnimationMixer(this.root);
    this.driver = new AnimationDriver(this.mixer, this.buildClips(), {
      walkRefSpeed: 2.2,
      runRefSpeed: 6,
    });
  }

  // ---- esqueleto (idéntico a TestDummy) ----

  private buildSkeleton(): THREE.Bone[] {
    const hips = new THREE.Bone(); hips.name = BONE_NAME.hips; hips.position.set(0, 0, 0);
    const spine = new THREE.Bone(); spine.name = BONE_NAME.spine; spine.position.set(0, 0.5, 0);
    const head = new THREE.Bone(); head.name = BONE_NAME.head; head.position.set(0, 0.5, 0);
    const armR = new THREE.Bone(); armR.name = BONE_NAME.armR; armR.position.set(0.42, 0.35, 0);
    const armL = new THREE.Bone(); armL.name = BONE_NAME.armL; armL.position.set(-0.42, 0.35, 0);
    spine.add(head, armR, armL);
    hips.add(spine);
    this.root.add(hips);

    // Sockets de props (empties que cuelgan de los huesos → siguen la animación).
    const socketHandR = new THREE.Object3D(); socketHandR.position.set(0, -0.30, 0.02); armR.add(socketHandR);
    const socketHandL = new THREE.Object3D(); socketHandL.position.set(0, -0.30, 0.02); armL.add(socketHandL);
    const socketBack = new THREE.Object3D(); socketBack.position.set(0, 0.25, 0.24); spine.add(socketBack);
    this.sockets = { handR: socketHandR, handL: socketHandL, back: socketBack };

    return [hips, spine, head, armR, armL];
  }

  // ---- materiales ----

  private toonMat(color: number, opts?: { emissive?: number; glow?: number }): THREE.MeshToonMaterial {
    const mat = new THREE.MeshToonMaterial({
      color,
      gradientMap: this.ramp,
      emissive: opts?.emissive != null ? new THREE.Color(opts.emissive) : new THREE.Color(0x000000),
      emissiveIntensity: opts?.glow ?? (opts?.emissive != null ? 0.7 : 1),
    });
    this.ownedMaterials.push(mat);
    return mat;
  }

  // ---- cuerpo ----

  private buildBody(spec: ArchetypeSpec): void {
    const p = spec.palette;
    const wide = spec.body === "wide";

    // Materiales por zona (patchados a su TintZone donde aplica).
    const skinMat = this.toonMat(p.skin);
    const primaryMat = this.toonMat(p.primary);
    const secondaryMat = this.toonMat(p.secondary);
    const hairMat = this.toonMat(p.hair);
    const accentMat = this.toonMat(p.accent, spec.glow ? { emissive: p.accent, glow: spec.glow } : undefined);
    const shoeMat = this.toonMat(p.shoes ?? 0x3a2a1e);
    this.tint.patchZone(primaryMat, "primary");
    this.tint.patchZone(secondaryMat, "secondary");
    this.tint.patchZone(hairMat, "hair");
    this.tint.patchZone(skinMat, "skin");
    this.tint.patchZone(accentMat, "accent");

    const torsoMat = spec.bareTorso ? skinMat : primaryMat;
    const torsoW = wide ? 0.74 : 0.58;
    const torsoD = wide ? 0.44 : 0.36;
    const armX = wide ? 0.46 : 0.4;

    // ── piernas + calzado (→ hips) ──────────────────────────────────────────
    for (const sx of [-1, 1] as const) {
      this.part(this.box(0.19, 0.42, 0.22, sx * 0.14, 0.33, 0), secondaryMat, BONE.hips);
      this.part(this.box(0.22, 0.13, 0.3, sx * 0.14, 0.06, -0.03), shoeMat, BONE.hips);
    }
    // pelvis (unión) → hips
    this.part(this.box(torsoW * 0.92, 0.2, torsoD * 0.9, 0, 0.6, 0), spec.bareTorso ? secondaryMat : primaryMat, BONE.hips);

    // ── torso (→ spine) ─────────────────────────────────────────────────────
    this.part(this.box(torsoW, 0.5, torsoD, 0, 0.82, 0), torsoMat, BONE.spine);

    // Abrigo/túnica largo: faldón trapezoidal bajo el torso (silueta).
    if (spec.coat && spec.coat !== "none") {
      const bottomY = spec.coat === "robe" ? 0.16 : 0.3;
      const skirt = this.trapezoid(torsoW * 0.96, torsoW * 1.24, 0.6 - bottomY, torsoD * 1.02);
      skirt.translate(0, (0.6 + bottomY) / 2 + 0.02, 0);
      this.part(skirt, primaryMat, BONE.hips);
    }

    // ── brazos + manos (→ armR/armL) ────────────────────────────────────────
    const sleeveMat = spec.bareTorso ? skinMat : primaryMat;
    this.part(this.box(0.16, 0.46, 0.16, armX, 0.62, 0), sleeveMat, BONE.armR);
    this.part(this.box(0.16, 0.46, 0.16, -armX, 0.62, 0), sleeveMat, BONE.armL);
    this.part(this.box(0.17, 0.14, 0.17, armX, 0.38, 0), skinMat, BONE.armR);
    this.part(this.box(0.17, 0.14, 0.17, -armX, 0.38, 0), skinMat, BONE.armL);
    if (spec.bareTorso) {
      // muñequeras de cuero (bodybuilder).
      this.part(this.box(0.19, 0.12, 0.19, armX, 0.47, 0), accentMat, BONE.armR);
      this.part(this.box(0.19, 0.12, 0.19, -armX, 0.47, 0), accentMat, BONE.armL);
    }

    // ── cabeza (chibi, grande) → head ───────────────────────────────────────
    this.part(this.sphere(0.34, 0, 1.26, 0), skinMat, BONE.head);
    this.buildFace(spec, skinMat, hairMat, accentMat);
    this.buildHair(spec, hairMat);
    this.buildHeadPiece(spec, primaryMat, secondaryMat, accentMat, hairMat);

    // ── decoración del torso (color/emisivo) ────────────────────────────────
    this.buildDecals(spec);
    this.buildExtras(spec, accentMat);
  }

  /** Cara: ojos + gafas + nariz-marcador (orientación −Z) + barba. */
  private buildFace(spec: ArchetypeSpec, skinMat: THREE.MeshToonMaterial, hairMat: THREE.MeshToonMaterial, accentMat: THREE.MeshToonMaterial): void {
    const fz = FRONT * 0.31;
    const eyeMat = this.toonMat(0x1a1622);
    for (const sx of [-1, 1] as const) {
      this.part(this.box(0.07, 0.09, 0.04, sx * 0.13, 1.3, fz), eyeMat, BONE.head, false);
    }
    // Nariz-marcador emisivo (mira al frente) — muy sutil.
    const nose = new THREE.ConeGeometry(0.045, 0.12, 8);
    nose.rotateX(FRONT * Math.PI / 2);
    nose.translate(0, 1.22, fz - 0.02 * FRONT);
    this.part(nose, skinMat, BONE.head, false);

    if (spec.glasses && spec.glasses !== "none") {
      const green = spec.glasses === "ar";
      const gMat = green
        ? this.toonMat(0x8ace3b, { emissive: 0x8ace3b, glow: 0.9 })
        : this.toonMat(0x14121a);
      // Puente + dos lentes.
      this.part(this.box(0.34, 0.05, 0.04, 0, 1.31, fz - 0.02 * FRONT), gMat, BONE.head, false);
      for (const sx of [-1, 1] as const) {
        this.part(this.box(0.14, 0.11, 0.03, sx * 0.13, 1.31, fz - 0.02 * FRONT), gMat, BONE.head, false);
      }
    }

    if (spec.beard) {
      // Barba: caja baja alrededor de la mandíbula, color pelo.
      this.part(this.box(0.4, 0.22, 0.34, 0, 1.06, FRONT * 0.06), hairMat, BONE.head);
    }
  }

  /** Pelo: casquete/melena según estilo, color `hair`. */
  private buildHair(spec: ArchetypeSpec, hairMat: THREE.MeshToonMaterial): void {
    switch (spec.hair) {
      case "none":
        return;
      case "spiky": {
        // Casquete + puntas (conos) desordenadas.
        const cap = new THREE.SphereGeometry(0.37, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.58);
        cap.translate(0, 1.3, 0);
        this.part(cap, hairMat, BONE.head);
        const spikes: [number, number, number][] = [
          [0, 1.62, 0.02], [0.14, 1.58, 0.06], [-0.14, 1.58, 0.04],
          [0.08, 1.6, -0.12], [-0.08, 1.59, -0.14], [0.2, 1.5, -0.02],
        ];
        for (const [x, y, z] of spikes) {
          const s = new THREE.ConeGeometry(0.07, 0.2, 6);
          s.translate(x, y, z);
          this.part(s, hairMat, BONE.head, false);
        }
        break;
      }
      case "long": {
        const cap = new THREE.SphereGeometry(0.38, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
        cap.translate(0, 1.29, 0);
        this.part(cap, hairMat, BONE.head);
        // Melena por la espalda (+Z es la nuca) hasta los hombros.
        this.part(this.box(0.5, 0.6, 0.16, 0, 1.0, -FRONT * 0.28), hairMat, BONE.head);
        // Mechones a los lados.
        for (const sx of [-1, 1] as const) {
          this.part(this.box(0.12, 0.5, 0.2, sx * 0.32, 1.05, 0), hairMat, BONE.head);
        }
        break;
      }
      case "bun": {
        const cap = new THREE.SphereGeometry(0.37, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.6);
        cap.translate(0, 1.29, 0);
        this.part(cap, hairMat, BONE.head);
        this.part(this.sphere(0.16, 0, 1.6, -FRONT * 0.16), hairMat, BONE.head);
        break;
      }
      default: {
        // short: casquete simple.
        const cap = new THREE.SphereGeometry(0.37, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
        cap.translate(0, 1.31, 0);
        this.part(cap, hairMat, BONE.head);
      }
    }
  }

  /** Pieza de cabeza icónica (gorro, boina, capucha, sombrero de ala, cuello-capa). */
  private buildHeadPiece(
    spec: ArchetypeSpec,
    primaryMat: THREE.MeshToonMaterial,
    secondaryMat: THREE.MeshToonMaterial,
    accentMat: THREE.MeshToonMaterial,
    hairMat: THREE.MeshToonMaterial,
  ): void {
    switch (spec.head) {
      case "boina": {
        // Boina: disco achatado ladeado, color acento.
        const beret = new THREE.CylinderGeometry(0.4, 0.36, 0.14, 20);
        beret.rotateZ(0.14);
        beret.translate(0.03, 1.56, 0);
        this.part(beret, accentMat, BONE.head);
        // Rabito.
        this.part(this.sphere(0.05, 0.03, 1.66, 0), accentMat, BONE.head, false);
        break;
      }
      case "gorro": {
        // Gorro de tela (color ropa principal), no metal — cubre la corona.
        const cap = new THREE.SphereGeometry(0.39, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
        cap.scale(1.02, 1.05, 1.05);
        cap.translate(0, 1.34, 0);
        this.part(cap, primaryMat, BONE.head);
        // Vuelta/banda de acento.
        const band = new THREE.TorusGeometry(0.36, 0.05, 8, 20);
        band.rotateX(Math.PI / 2);
        band.translate(0, 1.34, 0);
        this.part(band, accentMat, BONE.head, false);
        break;
      }
      case "capucha": {
        // Capucha: casquete que cubre corona y nuca dejando la CARA despejada.
        const hood = new THREE.SphereGeometry(0.45, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.52);
        hood.scale(1.06, 1.16, 1.2);
        hood.translate(0, 1.32, FRONT * -0.06); // ligeramente hacia la nuca (+Z)
        this.part(hood, primaryMat, BONE.head);
        // Drapeado trasero de la capucha (nuca).
        this.part(this.box(0.52, 0.46, 0.16, 0, 1.06, -FRONT * 0.26), primaryMat, BONE.head);
        // Reborde del cuello (→ spine).
        const ring = new THREE.TorusGeometry(0.26, 0.09, 8, 20);
        ring.rotateX(Math.PI / 2);
        ring.translate(0, 1.02, 0);
        this.part(ring, primaryMat, BONE.spine);
        break;
      }
      case "sombrero-ala": {
        // Ala ancha + copa.
        const brim = new THREE.CylinderGeometry(0.56, 0.6, 0.06, 24);
        brim.translate(0, 1.5, 0);
        this.part(brim, secondaryMat, BONE.head);
        const crown = new THREE.CylinderGeometry(0.34, 0.38, 0.26, 20);
        crown.translate(0, 1.63, 0);
        this.part(crown, secondaryMat, BONE.head);
        // Banda.
        const band = new THREE.CylinderGeometry(0.39, 0.39, 0.08, 20);
        band.translate(0, 1.53, 0);
        this.part(band, accentMat, BONE.head, false);
        if (spec.leaves) {
          // Hojas sobre la copa (verdes) — color, no detalle fino.
          const leafMat = this.toonMat(0x5a8f3a);
          const spots: [number, number, number][] = [
            [0.14, 1.74, 0.06], [-0.12, 1.72, 0.1], [0.02, 1.78, -0.12],
            [0.22, 1.68, -0.04], [-0.2, 1.7, -0.02], [0, 1.72, 0.16],
          ];
          for (const [x, y, z] of spots) {
            this.part(this.sphere(0.08, x, y, z), leafMat, BONE.head, false);
          }
        }
        break;
      }
      case "pelo-largo":
        // El estilo de pelo `long` ya cubre esto; nada extra.
        break;
      case "cuello-capa":
        // Se resuelve en buildExtras (capa alta con interior de color).
        break;
      default:
        break;
    }
  }

  /** Decoración del torso resuelta con color/emisivo (código, estrellas, salpicaduras, filigrana). */
  private buildDecals(spec: ArchetypeSpec): void {
    const fz = FRONT * (spec.body === "wide" ? 0.23 : 0.19);
    const place = (mat: THREE.MeshToonMaterial, spots: [number, number][], size = 0.06) => {
      for (const [x, y] of spots) {
        this.part(this.box(size, size, 0.02, x, y, fz), mat, BONE.spine, false);
      }
    };
    switch (spec.decal) {
      case "code": {
        const neon = this.toonMat(0x8ace3b, { emissive: 0x8ace3b, glow: 1.0 });
        place(neon, [[-0.16, 0.95], [0.14, 1.0], [-0.05, 0.82], [0.2, 0.88], [-0.2, 0.7], [0.06, 0.72]], 0.05);
        // Calavera-símbolo verde en el pecho.
        this.part(this.box(0.16, 0.14, 0.02, 0, 0.9, fz), neon, BONE.spine, false);
        break;
      }
      case "stars": {
        const gold = this.toonMat(spec.palette.accent, { emissive: spec.palette.accent, glow: 0.9 });
        const stars: [number, number, number][] = [
          [-0.18, 0.98, 0], [0.16, 1.02, 0], [0.02, 0.9, 0], [-0.1, 0.78, 0],
          [0.2, 0.82, 0], [-0.22, 0.66, 0], [0.1, 0.7, 0], [0.24, 0.94, 0],
        ];
        for (const [x, y] of stars) {
          // Estrella = dos barritas cruzadas (emisivas).
          this.part(this.box(0.09, 0.02, 0.02, x, y, fz), gold, BONE.spine, false);
          this.part(this.box(0.02, 0.09, 0.02, x, y, fz), gold, BONE.spine, false);
        }
        break;
      }
      case "splatter": {
        const colors = [0xc0506a, 0x4a8f7b, 0xd8c56a, 0x5a6fb0, 0xc98a3a, 0x7a5ba0];
        const spots: [number, number, number][] = [
          [-0.16, 0.98, 0], [0.14, 0.92, 0], [-0.02, 0.8, 0], [0.2, 1.0, 0],
          [-0.2, 0.72, 0], [0.08, 0.68, 0], [0.22, 0.8, 0], [-0.12, 0.88, 0],
        ];
        spots.forEach(([x, y], i) => {
          const m = this.toonMat(colors[i % colors.length]);
          this.part(this.sphere(0.055, x, y, fz), m, BONE.spine, false);
        });
        break;
      }
      case "filigree": {
        const gold = this.toonMat(spec.palette.accent, { emissive: spec.palette.accent, glow: 0.55 });
        // Ribetes dorados verticales (solapa del abrigo) + botones.
        for (const sx of [-1, 1] as const) {
          this.part(this.box(0.03, 0.5, 0.02, sx * 0.12, 0.82, fz), gold, BONE.spine, false);
        }
        for (const y of [1.0, 0.9, 0.8, 0.7]) {
          this.part(this.sphere(0.028, 0, y, fz), gold, BONE.spine, false);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Extras específicos: cuello-capa (vampiro), bufanda, broche, audífonos, cuentas. */
  private buildExtras(spec: ArchetypeSpec, accentMat: THREE.MeshToonMaterial): void {
    const p = spec.palette;

    if (spec.head === "cuello-capa") {
      // Cuello-capa ALTO estilo vampiro: se yergue DETRÁS de la cabeza (nuca), con
      // interior ROJO visible por dentro. La cara queda despejada al frente.
      const backZ = -FRONT * 0.13; // hacia la nuca (+Z)
      const outer = new THREE.CylinderGeometry(0.33, 0.22, 0.52, 20, 1, true);
      outer.translate(0, 1.24, backZ);
      const outerMat = this.toonMat(p.primary);
      outerMat.side = THREE.DoubleSide;
      const m = this.skinned(outer, outerMat, BONE.spine);
      this.meshes.push(m); this.root.add(m);
      // Forro interior rojo (algo menor), visible desde el frente hacia dentro.
      const inner = new THREE.CylinderGeometry(0.3, 0.2, 0.5, 20, 1, true);
      inner.translate(0, 1.24, backZ);
      const innerMat = this.toonMat(p.accent);
      innerMat.side = THREE.DoubleSide;
      const mi = this.skinned(inner, innerMat, BONE.spine);
      this.meshes.push(mi); this.root.add(mi);
      // Capa por la espalda.
      const cape = this.trapezoid(0.6, 0.9, 0.9, 0.04);
      cape.translate(0, 0.62, -FRONT * 0.24);
      this.part(cape, this.toonMat(p.primary), BONE.spine);
    }

    if (spec.scarf != null) {
      const scarfMat = this.toonMat(spec.scarf);
      const ring = new THREE.TorusGeometry(0.24, 0.07, 8, 18);
      ring.rotateX(Math.PI / 2);
      ring.translate(0, 1.04, 0);
      this.part(ring, scarfMat, BONE.spine);
      // Cola de la bufanda colgando al frente.
      this.part(this.box(0.12, 0.3, 0.06, -0.08, 0.86, FRONT * 0.2), scarfMat, BONE.spine, false);
    }

    if (spec.brooch != null) {
      const b = this.toonMat(spec.brooch, { emissive: spec.brooch, glow: 0.6 });
      this.part(this.sphere(0.05, 0, 1.02, FRONT * 0.14), b, BONE.spine, false);
    }

    if (spec.headphones) {
      const band = new THREE.TorusGeometry(0.36, 0.04, 8, 20, Math.PI);
      band.translate(0, 1.4, 0);
      this.part(band, this.toonMat(0x16151b), BONE.head, false);
      for (const sx of [-1, 1] as const) {
        this.part(this.box(0.1, 0.16, 0.12, sx * 0.35, 1.28, 0), this.toonMat(0x16151b), BONE.head, false);
        // Aro verde emisivo en la copa.
        const ring = new THREE.TorusGeometry(0.06, 0.02, 6, 14);
        ring.rotateY(Math.PI / 2);
        ring.translate(sx * 0.41, 1.28, 0);
        this.part(ring, this.toonMat(0x8ace3b, { emissive: 0x8ace3b, glow: 1 }), BONE.head, false);
      }
    }

    if (spec.bareTorso) {
      // Arneses de cuero en X sobre el torso (bodybuilder).
      for (const sx of [-1, 1] as const) {
        const strap = this.box(0.07, 0.62, 0.05, sx * 0.1, 0.82, FRONT * 0.2);
        strap.rotateZ(sx * 0.32);
        this.part(strap, accentMat, BONE.spine, false);
      }
      // Hebilla/medallón.
      this.part(this.sphere(0.06, 0, 0.82, FRONT * 0.22), this.toonMat(0xc9a24a, { emissive: 0xc9a24a, glow: 0.4 }), BONE.spine, false);
    }

    if (spec.charms) {
      // Collar de cuentas (chamán): esferas de colores alrededor del cuello.
      const beadColors = [0x3f8f86, 0xb6873f, 0xc0503a, 0xd8c56a];
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * 0.2 + (i / 6) * Math.PI * 0.6;
        const x = Math.cos(a) * 0.24 * (i % 2 ? 1 : -1);
        const z = FRONT * (0.1 + Math.sin(a) * 0.06);
        this.part(this.sphere(0.035, x, 1.0 - (i % 3) * 0.04, z), this.toonMat(beadColors[i % beadColors.length]), BONE.spine, false);
      }
      // Diadema/venda con gema en la frente.
      this.part(this.sphere(0.04, 0, 1.4, FRONT * 0.3), this.toonMat(0x3f8f86, { emissive: 0x3f8f86, glow: 0.4 }), BONE.head, false);
    }
  }

  // ---- props (estáticos, parentados al socket handR) ----

  /** Construye un prop low-poly. Devuelve un grupo (vacío si `none`). */
  buildProp(kind: PropKind): THREE.Group {
    const g = new THREE.Group();
    const mat = (color: number, emissive?: number) => {
      const m = new THREE.MeshToonMaterial({
        color,
        gradientMap: this.ramp,
        emissive: emissive != null ? new THREE.Color(emissive) : new THREE.Color(0),
        emissiveIntensity: emissive != null ? 0.5 : 1,
      });
      this.ownedMaterials.push(m);
      return m;
    };
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, outline = true) => {
      this.ownedGeoms.push(geo);
      const mesh = new THREE.Mesh(geo, m);
      if (outline) addInvertedHullOutline(mesh, INK, 1.06);
      g.add(mesh);
      return mesh;
    };

    switch (kind) {
      case "pincel": {
        const handle = new THREE.CylinderGeometry(0.018, 0.022, 0.34, 8); handle.translate(0, 0.1, 0);
        add(handle, mat(0x8a6a3a));
        const ferrule = new THREE.CylinderGeometry(0.026, 0.026, 0.05, 8); ferrule.translate(0, 0.28, 0);
        add(ferrule, mat(0xb8b8c0), false);
        const tip = new THREE.ConeGeometry(0.03, 0.09, 8); tip.translate(0, 0.34, 0);
        add(tip, mat(0x8e1b2e));
        break;
      }
      case "baston": {
        const staff = new THREE.CylinderGeometry(0.028, 0.032, 0.95, 8); staff.translate(0, 0.28, 0);
        add(staff, mat(0x6b4a2a));
        // Cayado curvo arriba.
        const crook = new THREE.TorusGeometry(0.1, 0.03, 8, 16, Math.PI * 1.3); crook.rotateY(Math.PI / 2); crook.translate(0, 0.78, 0);
        add(crook, mat(0x7a5630));
        // Colgantes.
        for (let i = 0; i < 3; i++) {
          const bead = new THREE.SphereGeometry(0.03, 8, 6); bead.translate(0.06 - i * 0.05, 0.62 - i * 0.05, 0);
          add(bead, mat([0x3f8f86, 0xb6873f, 0xc0503a][i]), false);
        }
        break;
      }
      case "libro": {
        const cover = new THREE.BoxGeometry(0.24, 0.3, 0.07); cover.translate(0, 0.05, 0);
        add(cover, mat(0x5a2f1e));
        const pages = new THREE.BoxGeometry(0.2, 0.26, 0.05); pages.translate(0.02, 0.05, 0);
        add(pages, mat(0xe8e0cf), false);
        break;
      }
      case "catalejo": {
        const b1 = new THREE.CylinderGeometry(0.045, 0.05, 0.22, 10); b1.rotateZ(Math.PI / 2); b1.translate(0.02, 0.06, 0);
        add(b1, mat(0xc9a24a, 0xc9a24a));
        const b2 = new THREE.CylinderGeometry(0.032, 0.04, 0.16, 10); b2.rotateZ(Math.PI / 2); b2.translate(0.2, 0.06, 0);
        add(b2, mat(0x8a6a3a));
        break;
      }
      case "regadera": {
        const body = new THREE.CylinderGeometry(0.12, 0.1, 0.2, 12); body.translate(0, 0.05, 0);
        add(body, mat(0x4f7d78));
        const spout = new THREE.CylinderGeometry(0.02, 0.035, 0.24, 8); spout.rotateZ(-0.9); spout.translate(0.16, 0.12, 0);
        add(spout, mat(0x4f7d78));
        const rose = new THREE.CylinderGeometry(0.05, 0.04, 0.03, 10); rose.rotateZ(-0.9); rose.translate(0.27, 0.2, 0);
        add(rose, mat(0x3f6b66), false);
        const handle = new THREE.TorusGeometry(0.06, 0.014, 6, 14); handle.translate(-0.02, 0.2, 0);
        add(handle, mat(0x3f6b66), false);
        break;
      }
      case "maletin": {
        const body = new THREE.BoxGeometry(0.3, 0.22, 0.09); body.translate(0, 0.02, 0);
        add(body, mat(0x5a3d22));
        const handle = new THREE.TorusGeometry(0.06, 0.015, 6, 14); handle.rotateX(Math.PI / 2); handle.translate(0, 0.14, 0);
        add(handle, mat(0x3a2716), false);
        const clasp = new THREE.BoxGeometry(0.04, 0.03, 0.02); clasp.translate(0, 0.1, 0.05);
        add(clasp, mat(0xc9a24a, 0xc9a24a), false);
        break;
      }
      default:
        return g;
    }

    // Orienta el prop para que quede empuñado (mango hacia abajo, en la mano).
    g.rotation.set(0.2, 0, 0);
    return g;
  }

  // ---- geometría helpers ----

  private box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  }
  private sphere(r: number, x: number, y: number, z: number): THREE.BufferGeometry {
    const g = new THREE.SphereGeometry(r, 14, 12);
    g.translate(x, y, z);
    return g;
  }
  /** Prisma trapezoidal (faldón de abrigo): base inferior más ancha. */
  private trapezoid(topW: number, botW: number, h: number, d: number): THREE.BufferGeometry {
    const g = new THREE.CylinderGeometry(botW / 2, topW / 2, h, 4, 1);
    g.rotateY(Math.PI / 4);
    // Cilindro de 4 lados → prisma cuadrado; ajusta profundidad.
    g.scale(1, 1, d / botW);
    return g;
  }

  /** Añade una parte skinned al hueso, con outline skinned opcional. */
  private part(geo: THREE.BufferGeometry, mat: THREE.Material, boneIndex: number, outline = true): void {
    const mesh = this.skinned(geo, mat, boneIndex);
    this.meshes.push(mesh);
    this.root.add(mesh);
    if (outline) {
      const o = this.outline(geo, boneIndex);
      this.meshes.push(o);
      this.root.add(o);
    }
  }

  /** SkinnedMesh con skinning rígido: todos los vértices pesan 1 al hueso. */
  private skinned(geo: THREE.BufferGeometry, mat: THREE.Material, boneIndex: number): THREE.SkinnedMesh {
    this.applySkin(geo, boneIndex);
    this.ownedGeoms.push(geo);
    return new THREE.SkinnedMesh(geo, mat);
  }

  /** Outline inverted-hull SKINNED: geo expandida por normal, BackSide, misma piel. */
  private outline(src: THREE.BufferGeometry, boneIndex: number): THREE.SkinnedMesh {
    const g = src.clone();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute | undefined;
    if (nor) {
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) + nor.getX(i) * OUTLINE_EPS,
          pos.getY(i) + nor.getY(i) * OUTLINE_EPS,
          pos.getZ(i) + nor.getZ(i) * OUTLINE_EPS,
        );
      }
      pos.needsUpdate = true;
    }
    // src ya lleva skinIndex/skinWeight tras skinned(); el clone los hereda.
    this.ownedGeoms.push(g);
    const m = new THREE.SkinnedMesh(g, this.inkMat);
    m.renderOrder = -1;
    return m;
  }

  private applySkin(geo: THREE.BufferGeometry, boneIndex: number): void {
    if (geo.getAttribute("skinIndex")) return; // ya tiene (clone de outline)
    const count = geo.attributes.position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = boneIndex;
      skinWeight[i * 4] = 1;
    }
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  }

  // ---- clips (idénticos a TestDummy: idle/walk/jump) ----

  private buildClips(): THREE.AnimationClip[] {
    const B = BONE_NAME;
    const quat = (name: string, times: number[], eulers: [number, number, number][]) => {
      const values: number[] = [];
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (const [x, y, z] of eulers) {
        e.set(x, y, z);
        q.setFromEuler(e);
        values.push(q.x, q.y, q.z, q.w);
      }
      return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values);
    };
    const pos = (name: string, times: number[], ys: number[], baseY: number) => {
      const values: number[] = [];
      for (const y of ys) values.push(0, baseY + y, 0);
      return new THREE.VectorKeyframeTrack(`${name}.position`, times, values);
    };

    const idle = new THREE.AnimationClip("idle", 2.5, [
      quat(B.spine, [0, 1.25, 2.5], [[0.03, 0, 0], [-0.02, 0, 0], [0.03, 0, 0]]),
      quat(B.head, [0, 1.25, 2.5], [[-0.02, 0.05, 0], [0.02, -0.05, 0], [-0.02, 0.05, 0]]),
      pos(B.hips, [0, 1.25, 2.5], [0, 0.02, 0], 0),
    ]);
    const walk = new THREE.AnimationClip("walk", 1.0, [
      pos(B.hips, [0, 0.25, 0.5, 0.75, 1.0], [0, 0.06, 0, 0.06, 0], 0),
      quat(B.armR, [0, 0.5, 1.0], [[0.6, 0, 0], [-0.6, 0, 0], [0.6, 0, 0]]),
      quat(B.armL, [0, 0.5, 1.0], [[-0.6, 0, 0], [0.6, 0, 0], [-0.6, 0, 0]]),
      quat(B.spine, [0, 0.5, 1.0], [[0, 0.09, 0], [0, -0.09, 0], [0, 0.09, 0]]),
    ]);
    const jump = new THREE.AnimationClip("jump", 0.9, [
      pos(B.hips, [0, 0.15, 0.4, 0.7, 0.9], [0, -0.12, 0.32, 0, 0], 0),
      quat(B.armR, [0, 0.15, 0.4, 0.9], [[0.2, 0, 0], [0.4, 0, 0], [-1.4, 0, 0], [0.2, 0, 0]]),
      quat(B.armL, [0, 0.15, 0.4, 0.9], [[-0.2, 0, 0], [0.4, 0, 0], [-1.4, 0, 0], [-0.2, 0, 0]]),
      quat(B.spine, [0, 0.4, 0.9], [[0.15, 0, 0], [-0.1, 0, 0], [0.15, 0, 0]]),
    ]);
    return [idle, walk, jump];
  }

  // ---- IAvatarRig ----

  update(dt: number, state: AvatarDriveState): void {
    if (this.disposed) return;
    this.driver.update(dt, state);
  }

  setTint(palette: Partial<Record<TintZone, THREE.Color>>): void {
    for (const zone of Object.keys(palette) as TintZone[]) {
      const c = palette[zone];
      if (c) this.tint.set(zone, c);
    }
  }

  attachProp(mesh: THREE.Object3D, socket: PropSocket): void {
    this.sockets[socket].add(mesh);
  }

  dispose(): void {
    this.disposed = true;
    this.driver.dispose();
    for (const g of this.ownedGeoms) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.inkMat.dispose();
    this.skeleton.dispose();
    this.ramp.dispose();
    // Props externos añadidos por attachProp: libera sus recursos.
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry;
      if (geo && !this.ownedGeoms.includes(geo)) geo.dispose();
    });
  }
}

/** Fábrica: construye un rig chibi a partir de una especificación de arquetipo. */
export function buildChibi(spec: ArchetypeSpec): IAvatarRig {
  return new ChibiAvatar(spec);
}
