"""
generate.py — Generador Blender headless de los avatares chibi de Phygitalia.

Construye avatares chibi low-poly ESTILIZADOS (cabeza grande ~38%, cuerpo
compacto, manos mitón, pies bloque redondeado — nivel Crossy Road / Animal
Crossing) para los 9 arquetipos × 3 builds (f/m/n), COMPLETAMENTE riggeados con
un armature Mixamo COMPLETO (piernas que caminan de verdad) y materiales
NOMBRADOS por zona de tinte: primary / secondary / hair / skin / accent.

Salida:
  · GLB  → apps/web/public/assets/avatars/gen/<arquetipo>-<f|m|n>.glb
  · PNG  → apps/web/public/assets/avatars/thumbs/gen/<arquetipo>-<f|m|n>.png
           (thumbnail 512px 3/4, fondo transparente, workbench flat;
            un paso Node los pasa a .webp: tools/avatars/thumbs.mjs)

Sin texturas: color plano por material (el toon + tint del engine hacen el resto).
≤ 3000 tris por avatar. Skinning rígido por parte al hueso correcto (piernas →
huesos de pierna) con articulaciones de bola que ocultan las costuras al doblar.

Convención de ejes: Blender es Z-up; el personaje MIRA a +Y (su cara/ojos en +Y),
así el export glTF (+Y up) deja al avatar mirando a -Z en three.js — la MISMA
convención que el chibi procedural (FRONT = -Z). Lado izquierdo del personaje en
+X (nombres Mixamo Left*), derecho en -X.

Uso (PowerShell):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe" --background --python tools/avatars/generate.py
  # opcional:  -- --only hacker,vampiro   --builds f,m,n   --no-thumbs
"""

import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Matrix, Euler

# --------------------------------------------------------------------------- #
#  Argumentos (tras el "--")
# --------------------------------------------------------------------------- #
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def _arg(flag, default=None):
    if flag in argv:
        i = argv.index(flag)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


ONLY = _arg("--only")  # p.ej. "hacker,vampiro"
BUILDS_ARG = _arg("--builds", "f,m,n")
NO_THUMBS = "--no-thumbs" in argv

# --------------------------------------------------------------------------- #
#  Rutas
# --------------------------------------------------------------------------- #
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(REPO, "apps", "web", "public", "assets", "avatars", "gen")
THUMB_DIR = os.path.join(REPO, "apps", "web", "public", "assets", "avatars", "thumbs", "gen")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

# --------------------------------------------------------------------------- #
#  Color: hex sRGB -> RGB lineal (Blender base_color / diffuse_color son lineales;
#  así el color final en three.js coincide con el hex de archetypes.ts).
# --------------------------------------------------------------------------- #


def _s2l(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h):
    r = (h >> 16) & 0xFF
    g = (h >> 8) & 0xFF
    b = h & 0xFF
    return (_s2l(r), _s2l(g), _s2l(b))


# --------------------------------------------------------------------------- #
#  Especificaciones de arquetipo (paridad con packages/engine/.../archetypes.ts)
#  palette: skin/primary/secondary/hair/accent/shoes
#  hair: short|spiky|long   head: none|capucha|boina|sombrero-ala|cuello-capa
#  coat: none|long|robe     prop: none|maletin|pincel|libro|catalejo|regadera|baston
#  flags: beard, glasses(none|ar|round), headphones, leaves, charms, bareTorso,
#         brooch(hex|None), scarf(hex|None), glow(0..1)
# --------------------------------------------------------------------------- #
SPECS = {
    "hacker": dict(
        name="Hacker",
        palette=dict(skin=0xE6B58F, primary=0x181A1D, secondary=0x24262B, hair=0x14140F, accent=0x8ACE3B, shoes=0x1C1E20),
        hair="spiky", head="capucha", glasses="ar", coat="none", prop="none",
        headphones=True, glow=0.9,
    ),
    "godines": dict(
        name="Godines",
        palette=dict(skin=0xD8A57A, primary=0xE8E2D4, secondary=0x33353B, hair=0x4A3423, accent=0x8A6A3A, shoes=0x3A2716),
        hair="short", head="none", glasses="round", coat="none", prop="maletin",
        tie=0x33353B,
    ),
    "artista": dict(
        name="Artista",
        palette=dict(skin=0xE6B58F, primary=0xCDBB93, secondary=0x2B2D3A, hair=0x3A2F2A, accent=0x5A4B6E, shoes=0x4A3320),
        hair="short", head="boina", coat="long", prop="pincel", scarf=0x2F3F66,
    ),
    "licenciado": dict(
        name="Licenciado",
        palette=dict(skin=0xD8A57A, primary=0x1B2740, secondary=0x14161F, hair=0x241A12, accent=0xC9A24A, shoes=0x4A3320),
        hair="short", head="none", coat="long", prop="libro", glow=0.4,
    ),
    "vampiro": dict(
        name="Vampiro",
        palette=dict(skin=0xECDCD0, primary=0x17151B, secondary=0x100F14, hair=0x1A1620, accent=0x8E1B2E, shoes=0x120F16),
        hair="spiky", head="cuello-capa", coat="long", prop="none", brooch=0x8E1B2E,
    ),
    "astronomo": dict(
        name="Astronomo",
        palette=dict(skin=0xE6B58F, primary=0x1B2740, secondary=0x172033, hair=0x201D2E, accent=0xD9B24A, shoes=0x3A2C1A),
        hair="spiky", head="gorro", coat="robe", prop="catalejo", glow=0.9, stars=True,
    ),
    "chaman": dict(
        name="Chaman",
        palette=dict(skin=0xC69A6A, primary=0x5A6B3A, secondary=0x8A7C52, hair=0xE8E6DF, accent=0xB6873F, shoes=0x4A3320),
        hair="long", head="none", beard=True, coat="robe", prop="baston", charms=True,
    ),
    "bodybuilder": dict(
        name="Bodybuilder",
        palette=dict(skin=0xD99A63, primary=0x2A2320, secondary=0x2A2320, hair=0x3A2718, accent=0x6B4A2A, shoes=0x2A1F16),
        body="wide", bareTorso=True, hair="spiky", head="none", beard=True, coat="none", prop="none",
    ),
    "dedo-verde": dict(
        name="Dedo Verde",
        palette=dict(skin=0xCF9A6A, primary=0x4F7D78, secondary=0x6D7D45, hair=0x4A3423, accent=0xB89A4A, shoes=0x4A3320),
        hair="short", head="sombrero-ala", beard=True, coat="none", prop="regadera", leaves=True,
    ),
}

ARCHETYPE_ORDER = [
    "hacker", "godines", "artista", "licenciado", "vampiro",
    "astronomo", "chaman", "bodybuilder", "dedo-verde",
]

# Builds: f = caderas más anchas + melena; m = hombros más anchos; n = intermedio.
BUILDS = {
    "f": dict(hip=1.16, shoulder=0.90, torso=0.93, chest=0.92, longHair=True),
    "m": dict(hip=0.90, shoulder=1.18, torso=1.06, chest=1.10, longHair=False),
    "n": dict(hip=1.00, shoulder=1.00, torso=1.00, chest=1.00, longHair=False),
}

# --------------------------------------------------------------------------- #
#  Esqueleto Mixamo (coords Blender, Z-up, cara a +Y, Left en +X).
#  (nombre, head, tail, parent)
# --------------------------------------------------------------------------- #
PFX = "mixamorig:"
BONES = [
    (PFX + "Hips", (0, 0, 0.64), (0, 0, 0.78), None),
    (PFX + "Spine", (0, 0, 0.78), (0, 0, 0.90), PFX + "Hips"),
    (PFX + "Spine1", (0, 0, 0.90), (0, 0, 1.00), PFX + "Spine"),
    (PFX + "Spine2", (0, 0, 1.00), (0, 0, 1.06), PFX + "Spine1"),
    (PFX + "Neck", (0, 0, 1.06), (0, 0, 1.14), PFX + "Spine2"),
    (PFX + "Head", (0, 0, 1.14), (0, 0, 1.52), PFX + "Neck"),
    # Brazo izquierdo (+X)
    (PFX + "LeftShoulder", (0.05, 0, 1.03), (0.17, 0, 1.00), PFX + "Spine2"),
    (PFX + "LeftArm", (0.17, 0, 1.00), (0.29, 0, 0.84), PFX + "LeftShoulder"),
    (PFX + "LeftForeArm", (0.29, 0, 0.84), (0.39, 0, 0.68), PFX + "LeftArm"),
    (PFX + "LeftHand", (0.39, 0, 0.68), (0.45, 0, 0.60), PFX + "LeftForeArm"),
    # Brazo derecho (-X)
    (PFX + "RightShoulder", (-0.05, 0, 1.03), (-0.17, 0, 1.00), PFX + "Spine2"),
    (PFX + "RightArm", (-0.17, 0, 1.00), (-0.29, 0, 0.84), PFX + "RightShoulder"),
    (PFX + "RightForeArm", (-0.29, 0, 0.84), (-0.39, 0, 0.68), PFX + "RightArm"),
    (PFX + "RightHand", (-0.39, 0, 0.68), (-0.45, 0, 0.60), PFX + "RightForeArm"),
    # Pierna izquierda
    (PFX + "LeftUpLeg", (0.13, 0, 0.62), (0.13, 0, 0.36), PFX + "Hips"),
    (PFX + "LeftLeg", (0.13, 0, 0.36), (0.13, 0, 0.12), PFX + "LeftUpLeg"),
    (PFX + "LeftFoot", (0.13, 0, 0.12), (0.13, 0.16, 0.03), PFX + "LeftLeg"),
    (PFX + "LeftToeBase", (0.13, 0.16, 0.03), (0.13, 0.24, 0.03), PFX + "LeftFoot"),
    # Pierna derecha
    (PFX + "RightUpLeg", (-0.13, 0, 0.62), (-0.13, 0, 0.36), PFX + "Hips"),
    (PFX + "RightLeg", (-0.13, 0, 0.36), (-0.13, 0, 0.12), PFX + "RightUpLeg"),
    (PFX + "RightFoot", (-0.13, 0, 0.12), (-0.13, 0.16, 0.03), PFX + "RightLeg"),
    (PFX + "RightToeBase", (-0.13, 0.16, 0.03), (-0.13, 0.24, 0.03), PFX + "RightFoot"),
]

# Nombres de hueso cortos → completos (para asignar partes).
def B(short):
    return PFX + short


# --------------------------------------------------------------------------- #
#  Escena limpia + materiales
# --------------------------------------------------------------------------- #
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


MAT_ZONES = ("primary", "secondary", "hair", "skin", "accent")


def make_materials(palette, glow):
    mats = {}
    for zone in MAT_ZONES:
        col = hexcol(palette[zone])
        m = bpy.data.materials.new(name=zone)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*col, 1.0)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.85
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
        # El acento puede emitir (neón hacker, oro astrónomo…).
        if zone == "accent" and glow:
            if "Emission Color" in bsdf.inputs:
                bsdf.inputs["Emission Color"].default_value = (*col, 1.0)
            if "Emission Strength" in bsdf.inputs:
                bsdf.inputs["Emission Strength"].default_value = float(glow)
        # Color de viewport (workbench usa esto para el thumbnail).
        m.diffuse_color = (*col, 1.0)
        mats[zone] = m
    return mats


# --------------------------------------------------------------------------- #
#  Constructor de geometría: cada parte es un objeto con UNA vertex group (hueso)
#  y UN material; al final se unen todos (join preserva grupos y materiales).
# --------------------------------------------------------------------------- #
class Body:
    def __init__(self, mats, coll):
        self.mats = mats
        self.coll = coll
        self.parts = []

    def _finish(self, bm, name, bone, mat):
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        obj.data.materials.append(self.mats[mat])
        vg = obj.vertex_groups.new(name=bone)
        vg.add(list(range(len(mesh.vertices))), 1.0, "REPLACE")
        self.coll.objects.link(obj)
        self.parts.append(obj)
        return obj

    def box(self, name, bone, mat, size, loc, rot=None):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        M = Matrix.Translation(Vector(loc))
        if rot:
            M = M @ Euler(rot, "XYZ").to_matrix().to_4x4()
        M = M @ Matrix.Diagonal(Vector((size[0], size[1], size[2], 1.0)))
        bm.transform(M)
        return self._finish(bm, name, bone, mat)

    def sphere(self, name, bone, mat, r, loc, u=12, v=8, scale=(1, 1, 1)):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
        M = Matrix.Translation(Vector(loc)) @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
        bm.transform(M)
        return self._finish(bm, name, bone, mat)

    def ico(self, name, bone, mat, r, loc, sub=1, scale=(1, 1, 1)):
        bm = bmesh.new()
        try:
            bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
        except TypeError:
            bmesh.ops.create_icosphere(bm, subdivisions=sub, diameter=r * 2)
        M = Matrix.Translation(Vector(loc)) @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
        bm.transform(M)
        return self._finish(bm, name, bone, mat)

    def between(self, name, bone, mat, p0, p1, r0, r1, seg=8):
        """Cono/cilindro entre dos puntos (para miembros)."""
        p0 = Vector(p0)
        p1 = Vector(p1)
        d = p1 - p0
        length = d.length
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=length)
        # create_cone: eje en Z, centrado en origen, radius1 abajo (-Z), radius2 arriba (+Z).
        quat = Vector((0, 0, 1)).rotation_difference(d.normalized())
        M = Matrix.Translation((p0 + p1) / 2.0) @ quat.to_matrix().to_4x4()
        bm.transform(M)
        return self._finish(bm, name, bone, mat)

    def cyl(self, name, bone, mat, r0, r1, depth, loc, seg=10, rot=None):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=depth)
        M = Matrix.Translation(Vector(loc))
        if rot:
            M = M @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bm.transform(M)
        return self._finish(bm, name, bone, mat)

    def cap(self, name, bone, mat, r, loc, u=12, v=6, scale=(1, 1, 1), frac=0.55):
        """Casquete: media esfera (para pelo/gorros)."""
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
        # Recorta por debajo de z=0 local.
        bmesh.ops.bisect_plane(
            bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
            plane_co=(0, 0, -r * (1 - 2 * frac)), plane_no=(0, 0, -1), clear_inner=True,
        )
        M = Matrix.Translation(Vector(loc)) @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
        bm.transform(M)
        return self._finish(bm, name, bone, mat)


# --------------------------------------------------------------------------- #
#  Construcción del cuerpo por arquetipo + build
# --------------------------------------------------------------------------- #
def build_body(spec, build, mats, coll):
    body = Body(mats, coll)
    bp = BUILDS[build]
    wide = spec.get("body") == "wide"
    bare = spec.get("bareTorso", False)

    hipW = (0.30 if not wide else 0.36) * bp["hip"]
    shoulderW = (0.30 if not wide else 0.40) * bp["shoulder"]
    chestW = (0.30 if not wide else 0.40) * bp["chest"]
    torsoD = 0.22 * bp["torso"]

    torso_mat = "skin" if bare else "primary"

    # ── Cadera / pelvis (→ Hips) ── (bare torso = pantalón corto "primary" para
    # que la zona de tinte primary SIEMPRE exista aunque el torso vaya desnudo)
    body.box("pelvis", B("Hips"), "primary" if bare else "secondary",
             (hipW * 2, torsoD, 0.20), (0, 0, 0.70))

    # ── Torso (→ Spine1) ── tronco ligeramente troncocónico
    body.box("torso", B("Spine1"), torso_mat, (chestW * 2, torsoD, 0.32), (0, 0, 0.90))
    body.box("chest", B("Spine2"), torso_mat, (shoulderW * 2, torsoD * 1.02, 0.14), (0, 0, 1.02))

    # Faldón de abrigo/túnica (→ Hips) — silueta
    coat = spec.get("coat", "none")
    if coat in ("long", "robe"):
        bottom = 0.14 if coat == "robe" else 0.30
        top_r = max(hipW, chestW) * 1.05
        bot_r = top_r * 1.5
        h = 0.70 - bottom
        body.cyl("skirt", B("Hips"), "primary", bot_r, top_r, h,
                 (0, 0, bottom + h / 2), seg=12)

    # ── Piernas (→ UpLeg/Leg/Foot) — ¡piernas de verdad! ──
    for side, sx in (("Left", 1), ("Right", -1)):
        legx = sx * 0.13
        # Muslo
        body.between("thigh" + side, B(side + "UpLeg"), "secondary",
                     (legx, 0, 0.62), (legx, 0, 0.37), 0.105, 0.095, seg=8)
        # Rodilla (bola) — pertenece al muslo → oculta la costura al doblar
        body.ico("knee" + side, B(side + "UpLeg"), "secondary", 0.10, (legx, 0, 0.36), sub=1)
        # Espinilla
        body.between("shin" + side, B(side + "Leg"), "secondary",
                     (legx, 0, 0.36), (legx, 0, 0.13), 0.09, 0.075, seg=8)
        # Pie (bloque redondeado, hacia +Y)
        body.box("foot" + side, B(side + "Foot"), "accent" if False else "skin",
                 (0.16, 0.30, 0.10), (legx, 0.07, 0.06))
        # Zapato encima del pie usa material accent? Mejor secondary oscuro → shoes.
        # (usamos accent como cuero/calzado sólo si procede; por defecto piel→pie)

    # ── Brazos (→ Arm/ForeArm/Hand) ──
    sleeve = "skin" if bare else "primary"
    for side, sx in (("Left", 1), ("Right", -1)):
        sh = (sx * 0.17, 0, 1.00)
        el = (sx * 0.29, 0, 0.84)
        wr = (sx * 0.39, 0, 0.68)
        hand = (sx * 0.44, 0, 0.62)
        # Hombro (bola) → Spine2 para pivote limpio
        body.ico("shoulder" + side, B("Spine2"), sleeve, 0.10, sh, sub=1)
        # Brazo superior
        body.between("uparm" + side, B(side + "Arm"), sleeve, sh, el, 0.085, 0.075, seg=7)
        # Codo (bola) → Arm
        body.ico("elbow" + side, B(side + "Arm"), sleeve, 0.078, el, sub=1)
        # Antebrazo
        body.between("forearm" + side, B(side + "ForeArm"), sleeve, el, wr, 0.072, 0.062, seg=7)
        # Muñequera de cuero (bodybuilder)
        if bare:
            body.ico("wristband" + side, B(side + "ForeArm"), "accent", 0.085, wr, sub=1, scale=(1, 1, 0.7))
        # Mano mitón → Hand
        body.ico("hand" + side, B(side + "Hand"), "skin", 0.095, hand, sub=1, scale=(1.15, 0.75, 1.25))

    # ── Cabeza (chibi, grande) → Head ──
    head_c = (0, 0, 1.34)
    body.sphere("head", B("Head"), "skin", 0.32, head_c, u=14, v=10)
    # Cara (mira a +Y): ojos pequeños oscuros (punto sobre la piel, estilo Crossy
    # Road/Animal Crossing — leen limpio sin "blancos" y son baratos).
    for ex in (-0.115, 0.115):
        body.sphere("eye", B("Head"), "hair", 0.045, (ex, 0.30, 1.36), u=8, v=6, scale=(0.95, 0.6, 1.05))
    # Nariz-marcador sutil
    body.ico("nose", B("Head"), "skin", 0.028, (0, 0.325, 1.30), sub=0)

    build_hair(body, spec, build, head_c)
    build_head_piece(body, spec, head_c, hipW, chestW, torsoD)
    build_face_extras(body, spec, head_c)
    build_accents(body, spec, chestW, torsoD)
    build_prop(body, spec)

    return body


def build_hair(body, spec, build, head_c):
    # Un gorro alto (astrónomo) cubre la corona: sin pelo por delante para que la
    # cara quede LIBRE (si no, el casquete oscuro tapa el rostro).
    if spec.get("head") == "gorro":
        return
    style = spec.get("hair", "short")
    longHair = BUILDS[build]["longHair"]
    # Casquete base
    if style == "spiky":
        body.cap("hair_cap", B("Head"), "hair", 0.345, (0, 0, 1.335), u=14, v=8, frac=0.62)
        for (hx, hy, hz) in [(0, 0.02, 1.66), (0.14, 0.05, 1.60), (-0.14, 0.04, 1.60),
                             (0.08, -0.12, 1.62), (-0.08, -0.13, 1.61)]:
            body.cyl("spike", B("Head"), "hair", 0.06, 0.0, 0.18, (hx, hy, hz), seg=5)
    elif style == "long":
        body.cap("hair_cap", B("Head"), "hair", 0.35, (0, 0, 1.33), u=14, v=8, frac=0.66)
        # Melena por la nuca (-Y)
        body.box("hair_back", B("Head"), "hair", (0.46, 0.16, 0.52), (0, -0.24, 1.12))
    else:  # short
        body.cap("hair_cap", B("Head"), "hair", 0.345, (0, 0, 1.35), u=14, v=8, frac=0.55)
    # Variante melena para builds f (sobre cualquier arquetipo)
    if longHair and style != "long":
        body.box("hair_locks", B("Head"), "hair", (0.42, 0.14, 0.42), (0, -0.22, 1.18))
        for hx in (-0.28, 0.28):
            body.box("hair_side", B("Head"), "hair", (0.10, 0.16, 0.36), (hx, -0.02, 1.22))


def build_head_piece(body, spec, head_c, hipW, chestW, torsoD):
    head = spec.get("head", "none")
    if head == "capucha":
        # Capucha de espalda: cubre corona y nuca DEJANDO la cara libre (+Y).
        body.cap("hood", B("Head"), "primary", 0.37, (0, -0.07, 1.40), u=14, v=8, frac=0.52, scale=(1.08, 1.05, 0.98))
        body.box("hood_back", B("Head"), "primary", (0.44, 0.14, 0.46), (0, -0.24, 1.16))
        # Cuello de la sudadera (bajo, en el pecho — no un aro gigante).
        body.box("hood_neck", B("Spine2"), "primary", (0.34, 0.30, 0.10), (0, 0, 1.02))
    elif head == "boina":
        body.cyl("beret", B("Head"), "accent", 0.40, 0.36, 0.12, (0.03, 0, 1.60), seg=16, rot=(0, 0.14, 0))
        body.ico("beret_tip", B("Head"), "accent", 0.045, (0.05, 0, 1.68), sub=0)
    elif head == "gorro":
        # Gorro cónico ALTO de astrónomo/mago: se asienta sobre la corona (deja la
        # cara libre), ala + banda dorada y una estrellita en la punta.
        body.cyl("hat_cone", B("Head"), "primary", 0.32, 0.03, 0.44, (0, -0.03, 1.74), seg=16)
        body.cyl("hat_brim", B("Head"), "accent", 0.42, 0.45, 0.05, (0, 0, 1.55), seg=18)
        body.ico("hat_star", B("Head"), "accent", 0.05, (0, -0.03, 1.97), sub=0)
    elif head == "sombrero-ala":
        body.cyl("brim", B("Head"), "secondary", 0.58, 0.60, 0.05, (0, 0, 1.55), seg=20)
        body.cyl("crown", B("Head"), "secondary", 0.35, 0.38, 0.24, (0, 0, 1.66), seg=18)
        body.cyl("hat_band", B("Head"), "accent", 0.39, 0.39, 0.07, (0, 0, 1.57), seg=18)
        if spec.get("leaves"):
            for (lx, ly, lz) in [(0.14, 0.06, 1.78), (-0.12, 0.10, 1.76), (0.0, -0.12, 1.80), (0.20, -0.04, 1.74)]:
                body.ico("leaf", B("Head"), "accent", 0.07, (lx, ly, lz), sub=1, scale=(1, 1.4, 0.5))
    elif head == "cuello-capa":
        # Cuello-capa alto vampírico que se yergue DETRÁS de la cabeza (nuca, -Y),
        # con forro rojo; la cara (+Y) queda libre. + capa por la espalda.
        body.box("collar_L", B("Spine2"), "primary", (0.10, 0.16, 0.42), (0.22, -0.16, 1.18), rot=(0, -0.2, 0.25))
        body.box("collar_R", B("Spine2"), "primary", (0.10, 0.16, 0.42), (-0.22, -0.16, 1.18), rot=(0, 0.2, -0.25))
        body.box("collar_back", B("Spine2"), "primary", (0.42, 0.10, 0.40), (0, -0.24, 1.16))
        body.box("collar_in", B("Spine2"), "accent", (0.36, 0.06, 0.34), (0, -0.20, 1.14))
        body.box("cape", B("Spine"), "primary", (0.5, 0.05, 0.8), (0, -0.16, 0.72))


def build_face_extras(body, spec, head_c):
    g = spec.get("glasses", "none")
    if g == "ar":
        body.box("glass_bridge", B("Head"), "accent", (0.30, 0.03, 0.04), (0, 0.31, 1.37))
        for ex in (-0.12, 0.12):
            body.box("lens", B("Head"), "accent", (0.13, 0.03, 0.10), (ex, 0.31, 1.37))
    elif g == "round":
        body.cyl("lensL", B("Head"), "hair", 0.08, 0.08, 0.03, (-0.12, 0.31, 1.37), seg=12, rot=(math.pi / 2, 0, 0))
        body.cyl("lensR", B("Head"), "hair", 0.08, 0.08, 0.03, (0.12, 0.31, 1.37), seg=12, rot=(math.pi / 2, 0, 0))
    if spec.get("beard"):
        # Barba que abraza la mandíbula/mentón SIN tapar los ojos (queda bajo z~1.20).
        body.box("beard", B("Head"), "hair", (0.34, 0.20, 0.16), (0, 0.17, 1.10))
        body.box("beard_chin", B("Head"), "hair", (0.20, 0.16, 0.12), (0, 0.24, 1.04))
    if spec.get("headphones"):
        # Diadema oscura (barra sobre la corona, oreja a oreja) + copas + detalle neón.
        body.box("hp_band", B("Head"), "secondary", (0.72, 0.10, 0.07), (0, -0.02, 1.52))
        for ex in (-0.35, 0.35):
            body.box("hp_cup", B("Head"), "secondary", (0.11, 0.16, 0.18), (ex, 0, 1.33))
            body.box("hp_glow", B("Head"), "accent", (0.04, 0.10, 0.10), (ex * 1.08, 0, 1.33))


def build_accents(body, spec, chestW, torsoD):
    fy = torsoD / 2 + 0.01
    if spec.get("scarf") is not None:
        body.cyl("scarf", B("Spine2"), "accent", 0.26, 0.26, 0.10, (0, 0, 1.02), seg=16, rot=(math.pi / 2, 0, 0))
        body.box("scarf_tail", B("Spine1"), "accent", (0.12, 0.06, 0.28), (-0.06, fy, 0.86))
    if spec.get("brooch") is not None:
        body.ico("brooch", B("Spine2"), "accent", 0.05, (0, fy + 0.02, 1.04), sub=1)
    if spec.get("charms"):
        for i in range(6):
            a = -0.5 + i * 0.2
            body.ico("bead", B("Spine1"), "accent", 0.035, (a * 0.4, fy, 1.00 - abs(a) * 0.05), sub=0)
    if spec.get("bareTorso"):
        # Arneses de cuero en X
        for sx in (-1, 1):
            body.box("strap", B("Spine1"), "accent", (0.06, 0.05, 0.55), (sx * 0.10, fy - 0.01, 0.92),
                     rot=(0, sx * 0.32, 0))
    if spec.get("stars"):
        for (sxp, szp) in [(-0.16, 1.00), (0.14, 1.02), (0.02, 0.90), (-0.10, 0.80), (0.18, 0.86)]:
            body.box("star", B("Spine1"), "accent", (0.06, 0.02, 0.06), (sxp, fy, szp))
    if spec.get("tie") is not None:
        body.box("tie", B("Spine1"), "secondary", (0.07, 0.02, 0.30), (0, fy, 0.92))


def build_prop(body, spec):
    kind = spec.get("prop", "none")
    if kind == "none":
        return
    # Prop en la mano derecha (-X). Se skinnea a RightHand para seguir la animación.
    hb = B("RightHand")
    hx = -0.44
    hz = 0.60
    if kind == "maletin":
        body.box("case", hb, "accent", (0.30, 0.10, 0.22), (hx, 0.02, hz - 0.14))
        body.cyl("case_handle", hb, "secondary", 0.06, 0.06, 0.03, (hx, 0.02, hz), seg=10, rot=(math.pi / 2, 0, 0))
    elif kind == "pincel":
        body.between("brush_handle", hb, "accent", (hx, 0, hz + 0.02), (hx, 0, hz - 0.30), 0.02, 0.024, seg=6)
        body.cyl("brush_tip", hb, "accent", 0.03, 0.0, 0.10, (hx, 0, hz + 0.10), seg=6)
    elif kind == "libro":
        body.box("book", hb, "accent", (0.24, 0.08, 0.30), (hx, 0.06, hz - 0.10))
        body.box("book_pages", hb, "skin", (0.20, 0.05, 0.26), (hx, 0.10, hz - 0.10))
    elif kind == "catalejo":
        body.cyl("scope1", hb, "accent", 0.05, 0.055, 0.22, (hx, 0.02, hz), seg=10, rot=(0, math.pi / 2, 0))
        body.cyl("scope2", hb, "secondary", 0.035, 0.045, 0.16, (hx - 0.18, 0.02, hz), seg=10, rot=(0, math.pi / 2, 0))
    elif kind == "regadera":
        body.cyl("can_body", hb, "accent", 0.12, 0.10, 0.20, (hx, 0.0, hz), seg=12)
        body.between("can_spout", hb, "accent", (hx, 0.06, hz), (hx, 0.28, hz + 0.10), 0.03, 0.045, seg=6)
    elif kind == "baston":
        body.between("staff", hb, "accent", (hx, 0, hz + 0.40), (hx, 0, hz - 0.55), 0.03, 0.035, seg=6)
        body.cyl("staff_top", hb, "accent", 0.06, 0.06, 0.05, (hx, 0, hz + 0.42), seg=10)


# --------------------------------------------------------------------------- #
#  Armature
# --------------------------------------------------------------------------- #
def make_armature(coll):
    arm_data = bpy.data.armatures.new("mixamorig")
    arm_obj = bpy.data.objects.new("Armature", arm_data)
    coll.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    ebs = {}
    for name, head, tail, parent in BONES:
        eb = arm_data.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.use_connect = False
        ebs[name] = eb
    for name, head, tail, parent in BONES:
        if parent:
            ebs[name].parent = ebs[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


# --------------------------------------------------------------------------- #
#  Un avatar completo
# --------------------------------------------------------------------------- #
def build_avatar(arch_id, build):
    spec = SPECS[arch_id]
    reset_scene()

    # Colección para este avatar
    coll = bpy.context.scene.collection

    mats = make_materials(spec["palette"], spec.get("glow", 0))
    arm_obj = make_armature(coll)
    body = build_body(spec, build, mats, coll)

    # Unir todas las partes en una sola malla
    bpy.ops.object.select_all(action="DESELECT")
    for obj in body.parts:
        obj.select_set(True)
    mesh_obj = body.parts[0]
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.join()
    mesh_obj.name = "%s_%s" % (arch_id, build)

    # Suavizar normales para look chibi limpio
    for poly in mesh_obj.data.polygons:
        poly.use_smooth = True

    # Parentar a la armature con modificador Armature (bind por vertex groups).
    mesh_obj.parent = arm_obj
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    mod.use_vertex_groups = True

    tris = count_tris(mesh_obj)
    return arm_obj, mesh_obj, tris


def count_tris(obj):
    total = 0
    for poly in obj.data.polygons:
        n = len(poly.vertices)
        total += max(0, n - 2)
    return total


# --------------------------------------------------------------------------- #
#  Export GLB
# --------------------------------------------------------------------------- #
def export_glb(arch_id, build, arm_obj, mesh_obj):
    out = os.path.join(OUT_DIR, "%s-%s.glb" % (arch_id, build))
    bpy.ops.object.select_all(action="DESELECT")
    arm_obj.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    kwargs = dict(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_skins=True,
        export_animations=False,
        export_materials="EXPORT",
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # Compat: reintenta con el subconjunto mínimo.
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True)
    return out, os.path.getsize(out)


# --------------------------------------------------------------------------- #
#  Thumbnail 512px (workbench, fondo transparente, vista 3/4 frontal)
# --------------------------------------------------------------------------- #
def render_thumb(arch_id, build, arm_obj, mesh_obj):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    try:
        scene.view_settings.view_transform = "Standard"
    except Exception:
        pass

    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_shadows = False
    try:
        shading.show_cavity = False
    except Exception:
        pass
    # Luz de estudio frontal y brillante para que las CARAS lean limpias (evita la
    # banda oscura ecuatorial del estudio por defecto, que ilumina desde arriba).
    try:
        shading.use_world_space_lighting = True
        shading.studiolight_rotate_z = 0.0      # luz principal desde el frente (+Y/cámara)
        shading.studiolight_intensity = 1.7
    except Exception:
        pass

    # Cámara 3/4: el personaje mira a +Y → la cámara va al lado +Y. Ángulo casi a la
    # altura de la cara (menos picado) para retratos más favorecedores.
    cam_data = bpy.data.cameras.new("thumbcam")
    cam_data.lens = 60
    cam_obj = bpy.data.objects.new("thumbcam", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = Vector((1.25, 3.05, 1.42))
    target = Vector((0, 0, 1.02))
    direction = target - cam_obj.location
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam_obj

    out = os.path.join(THUMB_DIR, "%s-%s.png" % (arch_id, build))
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return out


# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def main():
    ids = ARCHETYPE_ORDER
    if ONLY:
        want = set(x.strip() for x in ONLY.split(","))
        ids = [i for i in ids if i in want]
    builds = [b.strip() for b in BUILDS_ARG.split(",") if b.strip() in BUILDS]

    print("=" * 60)
    print("Generador de avatares chibi — %d arquetipos × %d builds" % (len(ids), len(builds)))
    print("=" * 60)

    results = []
    for arch_id in ids:
        for build in builds:
            arm_obj, mesh_obj, tris = build_avatar(arch_id, build)
            glb, size = export_glb(arch_id, build, arm_obj, mesh_obj)
            thumb = None
            if not NO_THUMBS:
                thumb = render_thumb(arch_id, build, arm_obj, mesh_obj)
            kb = size / 1024.0
            flag = "" if (tris <= 3000 and size < 300 * 1024) else "  <-- REVISAR"
            print("  %-16s tris=%-5d  %6.1f KB  %s%s" % (
                "%s-%s" % (arch_id, build), tris, kb,
                "thumb ok" if thumb else "sin thumb", flag))
            results.append((arch_id, build, tris, size))

    print("=" * 60)
    over_tris = [r for r in results if r[2] > 3000]
    over_size = [r for r in results if r[3] >= 300 * 1024]
    print("Total: %d avatares. %d sobre 3k tris, %d sobre 300KB." % (
        len(results), len(over_tris), len(over_size)))
    print("GLB en:", OUT_DIR)
    if not NO_THUMBS:
        print("PNG en:", THUMB_DIR)


if __name__ == "__main__":
    main()
