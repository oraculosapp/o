import * as THREE from "three";
import { AnimationDriver } from "./AnimationDriver";
import { TintController, avatarToonRamp } from "./tint";
import type { AvatarDriveState, IAvatarRig, PropSocket, TintZone } from "./types";

/**
 * Maniquí chibi rigged construido 100% en código — sin dependencias de assets.
 * Permite ejercitar TODO el sistema de avatares (contrato IAvatarRig, driver de
 * animación con crossfade y fallbacks, tinte por zonas, sockets de props) HOY,
 * antes de que existan los GLB de Tripo3D.
 *
 * Anatomía: cabeza grande (~chibi), torso, dos brazos, base/piernas. Esqueleto
 * de 5 huesos (hips, spine, head, armR, armL) con skinning **rígido** (cada
 * mesh pesa 1 a un solo hueso), suficiente para un placeholder legible.
 *
 * Clips generados por código: `idle`, `walk`, `jump`. No genera `run`: así se
 * ejercita también el fallback del driver (run = walk acelerado).
 *
 * Materiales toon con zonas de tinte:
 *   - torso + base → `primary`
 *   - brazos       → `secondary`
 *   - pelo         → `hair`
 *   - cabeza (piel), nariz emisiva → sin tinte
 */
export class TestDummy implements IAvatarRig {
  readonly root = new THREE.Group();
  readonly height: number;

  private mixer: THREE.AnimationMixer;
  private driver: AnimationDriver;
  private tint = new TintController();
  private ramp = avatarToonRamp();
  private skeleton!: THREE.Skeleton;
  private meshes: THREE.SkinnedMesh[] = [];
  private sockets: Record<PropSocket, THREE.Object3D>;
  private disposed = false;

  // Nombres de hueso (los usan los tracks de animación).
  private static readonly BONE = { hips: "hips", spine: "spine", head: "head", armR: "armR", armL: "armL" };

  constructor() {
    const { skeleton, sockets } = this.build();
    this.skeleton = skeleton;
    this.sockets = sockets;

    // Altura real medida en pose de reposo.
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

  // ---- construcción del maniquí ----

  private build(): { skeleton: THREE.Skeleton; sockets: Record<PropSocket, THREE.Object3D> } {
    const B = TestDummy.BONE;

    // Esqueleto (posiciones locales; world = suma de la cadena).
    const hips = new THREE.Bone(); hips.name = B.hips; hips.position.set(0, 0, 0);
    const spine = new THREE.Bone(); spine.name = B.spine; spine.position.set(0, 0.5, 0);
    const head = new THREE.Bone(); head.name = B.head; head.position.set(0, 0.5, 0);
    const armR = new THREE.Bone(); armR.name = B.armR; armR.position.set(0.42, 0.35, 0);
    const armL = new THREE.Bone(); armL.name = B.armL; armL.position.set(-0.42, 0.35, 0);
    spine.add(head, armR, armL);
    hips.add(spine);
    this.root.add(hips);

    // Materiales toon por zona.
    const primaryMat = this.toonMat(0x6b8e4e); // ropa principal (verde salvia)
    const secondaryMat = this.toonMat(0xc9a96b); // ropa secundaria (arena)
    const hairMat = this.toonMat(0x3a2f2a); // pelo (marrón oscuro)
    const skinMat = this.toonMat(0xe6b58f); // piel (sin tinte)
    const noseMat = new THREE.MeshToonMaterial({
      color: 0x3a2f18,
      emissive: new THREE.Color(0xe3b063),
      emissiveIntensity: 0.9,
      gradientMap: this.ramp,
    });

    // Geometrías autoradas en coordenadas de reposo (world), skinning rígido.
    // base/piernas → hips
    const base = this.skinned(this.translated(new THREE.BoxGeometry(0.5, 0.5, 0.34), 0, 0.25, 0), primaryMat, 0);
    // torso → spine (world spine y=0.5)
    const torso = this.skinned(this.translated(new THREE.BoxGeometry(0.6, 0.55, 0.4), 0, 0.78, 0), primaryMat, 1);
    // brazos → armR/armL (hueso en world y≈0.85, x±0.42). El box cuelga por debajo.
    const armRMesh = this.skinned(this.translated(new THREE.BoxGeometry(0.16, 0.5, 0.16), 0.42, 0.62, 0), secondaryMat, 3);
    const armLMesh = this.skinned(this.translated(new THREE.BoxGeometry(0.16, 0.5, 0.16), -0.42, 0.62, 0), secondaryMat, 4);
    // cabeza (grande, chibi) → head (world y=1.0)
    const headMesh = this.skinned(this.translated(new THREE.SphereGeometry(0.36, 20, 16), 0, 1.3, 0), skinMat, 2);
    // pelo: casquete sobre la cabeza → head
    const hairGeo = new THREE.SphereGeometry(0.39, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const hairMesh = this.skinned(this.translated(hairGeo, 0, 1.32, 0), hairMat, 2);
    // nariz emisiva (marcador de orientación, mira a -Z) → head
    const noseGeo = new THREE.ConeGeometry(0.07, 0.18, 10);
    noseGeo.rotateX(-Math.PI / 2);
    const noseMesh = this.skinned(this.translated(noseGeo, 0, 1.28, -0.34), noseMat, 2);

    this.meshes = [base, torso, armRMesh, armLMesh, headMesh, hairMesh, noseMesh];

    // Bind: primero todo en el grafo y matrices de reposo actualizadas.
    for (const m of this.meshes) this.root.add(m);
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton([hips, spine, head, armR, armL]);
    for (const m of this.meshes) {
      m.bind(skeleton);
      m.frustumCulled = false; // evita culling erróneo al deformar
    }

    // Tinte por material (ruta precisa, multi-material).
    this.tint.patchZone(primaryMat, "primary");
    this.tint.patchZone(secondaryMat, "secondary");
    this.tint.patchZone(hairMat, "hair");

    // Sockets de props (empties que cuelgan de los huesos → siguen la animación).
    const socketHandR = new THREE.Object3D(); socketHandR.position.set(0, -0.32, 0.06); armR.add(socketHandR);
    const socketHandL = new THREE.Object3D(); socketHandL.position.set(0, -0.32, 0.06); armL.add(socketHandL);
    const socketBack = new THREE.Object3D(); socketBack.position.set(0, 0.25, -0.24); spine.add(socketBack);

    return {
      skeleton,
      sockets: { handR: socketHandR, handL: socketHandL, back: socketBack },
    };
  }

  private toonMat(color: number): THREE.MeshToonMaterial {
    return new THREE.MeshToonMaterial({ color, gradientMap: this.ramp });
  }

  private translated(geo: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
    geo.translate(x, y, z);
    return geo;
  }

  /** Crea un SkinnedMesh con skinning rígido: todos los vértices pesan 1 al hueso `boneIndex`. */
  private skinned(geo: THREE.BufferGeometry, mat: THREE.Material, boneIndex: number): THREE.SkinnedMesh {
    const count = geo.attributes.position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = boneIndex;
      skinWeight[i * 4] = 1;
    }
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    return new THREE.SkinnedMesh(geo, mat);
  }

  // ---- clips generados por código ----

  private buildClips(): THREE.AnimationClip[] {
    const B = TestDummy.BONE;

    const quat = (name: string, times: number[], eulers: [number, number, number][]): THREE.QuaternionKeyframeTrack => {
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
    // Track de posición: los valores son ABSOLUTOS en local, así que incluyen el offset base del hueso.
    const pos = (name: string, times: number[], ys: number[], baseY: number): THREE.VectorKeyframeTrack => {
      const values: number[] = [];
      for (const y of ys) values.push(0, baseY + y, 0);
      return new THREE.VectorKeyframeTrack(`${name}.position`, times, values);
    };

    // idle: respiración leve — balanceo del torso, cabeceo, bob mínimo de cadera.
    const idle = new THREE.AnimationClip("idle", 2.5, [
      quat(B.spine, [0, 1.25, 2.5], [[0.03, 0, 0], [-0.02, 0, 0], [0.03, 0, 0]]),
      quat(B.head, [0, 1.25, 2.5], [[-0.02, 0.05, 0], [0.02, -0.05, 0], [-0.02, 0.05, 0]]),
      pos(B.hips, [0, 1.25, 2.5], [0, 0.02, 0], 0),
    ]);

    // walk: cadera sube dos veces por ciclo, brazos en contrafase, torso contragira.
    const walk = new THREE.AnimationClip("walk", 1.0, [
      pos(B.hips, [0, 0.25, 0.5, 0.75, 1.0], [0, 0.06, 0, 0.06, 0], 0),
      quat(B.armR, [0, 0.5, 1.0], [[0.6, 0, 0], [-0.6, 0, 0], [0.6, 0, 0]]),
      quat(B.armL, [0, 0.5, 1.0], [[-0.6, 0, 0], [0.6, 0, 0], [-0.6, 0, 0]]),
      quat(B.spine, [0, 0.5, 1.0], [[0, 0.09, 0], [0, -0.09, 0], [0, 0.09, 0]]),
    ]);

    // jump: agacharse → impulso → subir → aterrizar, con brazos arriba en el pico.
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

  /** Emotes: no-op (el maniquí de 5 huesos no mapea el esqueleto Mixamo del EmoteDriver). */
  playEmote(_id: string): void {
    /* sin soporte de emotes */
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
    for (const m of this.meshes) {
      m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else mat.dispose();
    }
    this.skeleton.dispose();
    this.ramp.dispose();
  }
}
