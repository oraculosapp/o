"""
generate.py — Generador Blender headless del avatar "nube" de Phygitalia.

NUEVA DIRECCIÓN (S8): un ÚNICO diseño NEUTRO tipo plastilina / clay ("Not
Boring"): un cuerpo redondito de UN SOLO VOLUMEN, suave, cute, SIN detalles,
SÓLO 2 ojos. Nada de pelo/ropa/props/nariz/boca. La personalización es SÓLO el
color (lo pone el engine por tinte; la malla nace blanco neutro).

Cómo se logra la suavidad (CERO costuras):
  · El cuerpo es un conjunto de METABALLS (esferas de campo) que se FUNDEN en una
    sola superficie continua: cabeza esférica grande fundida con el cuerpo ovoide,
    brazos y piernas como salchichitas que emergen SIN cortes, manos/pies como
    bulbos apenas insinuados. Al convertir la metaball a malla sale una superficie
    watertight sin uniones ni bordes.
  · Skinning SUAVE: armature Mixamo COMPLETO (22 huesos) + pesos automáticos
    (bone-heat) SUAVIZADOS (vertex_group_smooth). Al doblar rodillas/codos la malla
    se CURVA como plastilina, sin quiebres.
  · Subdivisión + shade smooth para el acabado.

Salida:
  · GLB → apps/web/public/assets/avatars/gen/nube.glb   (design id: "nube")
  · PNG → apps/web/public/assets/avatars/thumbs/gen/nube.png
          (thumbnail 512px, fondo transparente; tools/avatars/thumbs.mjs → .webp)

Materiales NOMBRADOS: "body" (blanco neutro — zona de tinte principal en el
engine) y "eyes" (negro). ≤ 6000 tris.

Ejes: Blender Z-up, la CARA mira a +Y (ojos en +Y). El export glTF (+Y up) deja
al avatar mirando a -Z en three.js (misma convención que el resto de avatares).

Uso (PowerShell):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe" --background --python tools/avatars/generate.py
  # opcional:  -- --no-thumb   --res 0.05
"""

import bpy
import math
import os
import sys
from mathutils import Vector

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


NO_THUMB = "--no-thumb" in argv
RESOLUTION = float(_arg("--res", "0.05"))   # resolución de la metaball (menor = más fino)
TARGET_TRIS = int(_arg("--tris", "5200"))    # objetivo tras decimado (< 6000)

# --------------------------------------------------------------------------- #
#  Rutas
# --------------------------------------------------------------------------- #
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(REPO, "apps", "web", "public", "assets", "avatars", "gen")
THUMB_DIR = os.path.join(REPO, "apps", "web", "public", "assets", "avatars", "thumbs", "gen")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(THUMB_DIR, exist_ok=True)

DESIGN_ID = "nube"

# --------------------------------------------------------------------------- #
#  Color: hex sRGB -> RGB lineal (base_color de Blender es lineal → coincide con
#  el hex final en three.js).
# --------------------------------------------------------------------------- #


def _s2l(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h):
    return (_s2l((h >> 16) & 0xFF), _s2l((h >> 8) & 0xFF), _s2l(h & 0xFF))


# Blanco cálido neutro (el tinte del engine lo colorea) y negro para los ojos.
BODY_HEX = 0xEDEDE8
EYE_HEX = 0x141118

# --------------------------------------------------------------------------- #
#  Esqueleto Mixamo COMPLETO (22 huesos), adaptado a la proporción TIERNA del
#  clay (cabeza ~45%). Coords Blender Z-up, cara a +Y, lado izquierdo en +X.
#  (nombre, head, tail, parent)
# --------------------------------------------------------------------------- #
PFX = "mixamorig:"
BONES = [
    (PFX + "Hips", (0, 0, 0.46), (0, 0, 0.58), None),
    (PFX + "Spine", (0, 0, 0.58), (0, 0, 0.70), PFX + "Hips"),
    (PFX + "Spine1", (0, 0, 0.70), (0, 0, 0.82), PFX + "Spine"),
    (PFX + "Spine2", (0, 0, 0.82), (0, 0, 0.92), PFX + "Spine1"),
    (PFX + "Neck", (0, 0, 0.92), (0, 0, 1.00), PFX + "Spine2"),
    (PFX + "Head", (0, 0, 1.00), (0, 0, 1.36), PFX + "Neck"),
    # Brazo izquierdo (+X)
    (PFX + "LeftShoulder", (0.06, 0, 0.90), (0.22, 0, 0.90), PFX + "Spine2"),
    (PFX + "LeftArm", (0.22, 0, 0.90), (0.34, 0, 0.74), PFX + "LeftShoulder"),
    (PFX + "LeftForeArm", (0.34, 0, 0.74), (0.42, 0, 0.54), PFX + "LeftArm"),
    (PFX + "LeftHand", (0.42, 0, 0.54), (0.45, 0, 0.42), PFX + "LeftForeArm"),
    # Brazo derecho (-X)
    (PFX + "RightShoulder", (-0.06, 0, 0.90), (-0.22, 0, 0.90), PFX + "Spine2"),
    (PFX + "RightArm", (-0.22, 0, 0.90), (-0.34, 0, 0.74), PFX + "RightShoulder"),
    (PFX + "RightForeArm", (-0.34, 0, 0.74), (-0.42, 0, 0.54), PFX + "RightArm"),
    (PFX + "RightHand", (-0.42, 0, 0.54), (-0.45, 0, 0.42), PFX + "RightForeArm"),
    # Pierna izquierda
    (PFX + "LeftUpLeg", (0.15, 0, 0.46), (0.15, 0, 0.26), PFX + "Hips"),
    (PFX + "LeftLeg", (0.15, 0, 0.26), (0.15, 0, 0.10), PFX + "LeftUpLeg"),
    (PFX + "LeftFoot", (0.15, 0, 0.10), (0.15, 0.14, 0.04), PFX + "LeftLeg"),
    (PFX + "LeftToeBase", (0.15, 0.14, 0.04), (0.15, 0.22, 0.04), PFX + "LeftFoot"),
    # Pierna derecha
    (PFX + "RightUpLeg", (-0.15, 0, 0.46), (-0.15, 0, 0.26), PFX + "Hips"),
    (PFX + "RightLeg", (-0.15, 0, 0.26), (-0.15, 0, 0.10), PFX + "RightUpLeg"),
    (PFX + "RightFoot", (-0.15, 0, 0.10), (-0.15, 0.14, 0.04), PFX + "RightLeg"),
    (PFX + "RightToeBase", (-0.15, 0.14, 0.04), (-0.15, 0.22, 0.04), PFX + "RightFoot"),
]

# --------------------------------------------------------------------------- #
#  Elementos de la metaball: (x, y, z, radio_visible). El radio de campo se
#  escala por RF (con threshold/stiffness por defecto la superficie sale ~0.67×
#  del radio de campo). Todos BALL → se funden en un único volumen suave.
# --------------------------------------------------------------------------- #
RF = 1.49  # factor radio_campo / radio_visible

def _mirror(elems):
    out = []
    for (x, y, z, r) in elems:
        out.append((x, y, z, r))
        if abs(x) > 1e-6:
            out.append((-x, y, z, r))
    return out

# Torso + cabeza + cuello (línea central).
BODY_ELEMS = [
    (0, 0, 1.16, 0.36),   # cabeza (grande, ~45% de la altura)
    (0, 0, 1.00, 0.20),   # cuello (funde cabeza↔torso)
    (0, 0, 0.86, 0.28),   # torso alto
    (0, 0, 0.66, 0.30),   # torso medio (barriguita)
    (0, 0, 0.50, 0.26),   # cadera/base
]
# Brazos (salchichitas que emergen del torso, x=±).
ARM_ELEMS = _mirror([
    (0.24, 0, 0.90, 0.15),   # hombro
    (0.32, 0, 0.76, 0.12),   # brazo
    (0.39, 0, 0.62, 0.11),   # codo
    (0.42, 0, 0.50, 0.105),  # antebrazo
    (0.44, 0, 0.40, 0.12),   # mano (bulbo)
])
# Piernas (x=±0.15).
LEG_ELEMS = _mirror([
    (0.15, 0, 0.42, 0.15),    # muslo
    (0.15, 0, 0.28, 0.125),   # rodilla
    (0.15, 0, 0.16, 0.115),   # espinilla
    (0.15, 0.06, 0.07, 0.13), # pie (bulbo, hacia +Y)
])
ALL_ELEMS = BODY_ELEMS + ARM_ELEMS + LEG_ELEMS


# --------------------------------------------------------------------------- #
#  Escena
# --------------------------------------------------------------------------- #
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, hex_color, rough=0.85):
    m = bpy.data.materials.new(name=name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    col = hexcol(hex_color)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*col, 1.0)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = rough
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    m.diffuse_color = (*col, 1.0)  # viewport / workbench thumbnail
    return m


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
        # Envelope generoso (red de seguridad si los pesos automáticos fallan).
        eb.envelope_distance = 0.14
        eb.head_radius = 0.10
        eb.tail_radius = 0.10
        ebs[name] = eb
    for name, head, tail, parent in BONES:
        if parent:
            ebs[name].parent = ebs[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


def build_metaball_body(coll, body_mat):
    """Crea la metaball, la convierte a malla suave y le asigna el material body."""
    mball = bpy.data.metaballs.new("nubeMeta")
    mball.resolution = RESOLUTION
    mball.render_resolution = RESOLUTION
    mball.threshold = 0.6
    for (x, y, z, r) in ALL_ELEMS:
        el = mball.elements.new()
        el.co = (x, y, z)
        el.radius = r * RF
        el.stiffness = 2.0

    meta_obj = bpy.data.objects.new("nubeMeta", mball)
    coll.objects.link(meta_obj)

    bpy.ops.object.select_all(action="DESELECT")
    meta_obj.select_set(True)
    bpy.context.view_layer.objects.active = meta_obj
    bpy.ops.object.convert(target="MESH")   # metaball → malla watertight sin costuras
    body = bpy.context.view_layer.objects.active
    body.name = DESIGN_ID
    body.data.name = DESIGN_ID
    # El convert deja la malla centrada en el origen del objeto; aplica cualquier
    # transform residual para tener coords de mundo limpias (bind correcto).
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Material body (slot 0).
    body.data.materials.clear()
    body.data.materials.append(body_mat)
    return body


def add_eyes(coll, body, eye_mat):
    """2 ojos: esferitas negras achatadas, apenas hundidas en la cara (+Y)."""
    eyes = []
    for sx in (-1, 1):
        bpy.ops.object.select_all(action="DESELECT")
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.052,
                                              location=(sx * 0.135, 0.325, 1.20))
        eye = bpy.context.view_layer.objects.active
        eye.scale = (1.0, 0.62, 1.15)   # elipse: achatada en Y, alta en Z
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        eye.data.materials.clear()
        eye.data.materials.append(eye_mat)
        for poly in eye.data.polygons:
            poly.use_smooth = True
        eyes.append(eye)

    # Une los ojos al cuerpo → una sola malla con 2 slots (body, eyes).
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    for e in eyes:
        e.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    return body


def finish_mesh(body):
    """Normales fuera, decimado a ≤ TARGET_TRIS, subdivisión suave, shade smooth."""
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body

    # Normales consistentes hacia afuera.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    tris = tri_count(body)

    # Decimado si nos pasamos del presupuesto (< 6000 tris).
    if tris > TARGET_TRIS:
        dec = body.modifiers.new("Decimate", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = max(0.1, TARGET_TRIS / tris)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    # Subdivisión suave ligera (1 nivel) para pulir la curvatura del clay, y de
    # inmediato la aplicamos para dejar una malla estática skinnable. Se re-decima
    # si el subsurf disparó el conteo.
    if tri_count(body) * 4 <= 5800:
        sub = body.modifiers.new("Subsurf", type="SUBSURF")
        sub.levels = 1
        sub.render_levels = 1
        bpy.ops.object.modifier_apply(modifier=sub.name)
        if tri_count(body) > TARGET_TRIS:
            dec = body.modifiers.new("Decimate2", type="DECIMATE")
            dec.decimate_type = "COLLAPSE"
            dec.ratio = max(0.1, TARGET_TRIS / tri_count(body))
            bpy.ops.object.modifier_apply(modifier=dec.name)

    # Shade smooth (look plastilina).
    for poly in body.data.polygons:
        poly.use_smooth = True
    return tri_count(body)


def bind_soft(body, arm_obj):
    """Pesos automáticos (bone-heat) SUAVIZADOS → curvas de plastilina al doblar."""
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj

    bound = False
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        bound = len(body.vertex_groups) > 0
    except RuntimeError as e:
        print("  [warn] bone-heat falló (%s); uso envelopes" % e)
    if not bound:
        bpy.ops.object.select_all(action="DESELECT")
        body.select_set(True)
        arm_obj.select_set(True)
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")

    # Suaviza los pesos: bordes de doblez (codos/rodillas/hombros) sin quiebres.
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    try:
        bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
        bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=0.5, repeat=6)
        bpy.ops.object.mode_set(mode="OBJECT")
    except RuntimeError as e:
        print("  [warn] suavizado de pesos omitido (%s)" % e)
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError:
            pass


def tri_count(obj):
    total = 0
    for poly in obj.data.polygons:
        total += max(0, len(poly.vertices) - 2)
    return total


# --------------------------------------------------------------------------- #
#  Export GLB
# --------------------------------------------------------------------------- #
def export_glb(arm_obj, body):
    out = os.path.join(OUT_DIR, "%s.glb" % DESIGN_ID)
    bpy.ops.object.select_all(action="DESELECT")
    arm_obj.select_set(True)
    body.select_set(True)
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
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True)
    return out, os.path.getsize(out)


# --------------------------------------------------------------------------- #
#  Thumbnail 512px (workbench, fondo transparente, vista 3/4 frontal)
# --------------------------------------------------------------------------- #
def render_thumb(body):
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

    # FLAT + cavity: color de material a plena luz (el body queda casi blanco —
    # imprescindible: la web tinta la miniatura con multiply y una base oscura
    # ensuciaría los pasteles) + cavidad de pantalla para que el clay tenga volumen.
    shading = scene.display.shading
    shading.light = "FLAT"
    shading.color_type = "MATERIAL"
    shading.show_shadows = False
    try:
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.curvature_ridge_factor = 0.5
        shading.curvature_valley_factor = 0.9
        shading.cavity_ridge_factor = 0.6
        shading.cavity_valley_factor = 0.9
    except Exception:
        pass

    cam_data = bpy.data.cameras.new("thumbcam")
    cam_data.lens = 55
    cam_obj = bpy.data.objects.new("thumbcam", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = Vector((0.95, 2.65, 1.10))
    target = Vector((0, 0, 0.78))
    direction = target - cam_obj.location
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam_obj

    out = os.path.join(THUMB_DIR, "%s.png" % DESIGN_ID)
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return out


# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def main():
    print("=" * 60)
    print('Generador avatar "nube" (clay, un solo volumen)')
    print("=" * 60)

    reset_scene()
    coll = bpy.context.scene.collection

    body_mat = make_material("body", BODY_HEX)
    eye_mat = make_material("eyes", EYE_HEX, rough=0.5)

    arm_obj = make_armature(coll)
    body = build_metaball_body(coll, body_mat)
    body = add_eyes(coll, body, eye_mat)
    tris = finish_mesh(body)
    bind_soft(body, arm_obj)

    glb, size = export_glb(arm_obj, body)
    thumb = None
    if not NO_THUMB:
        thumb = render_thumb(body)

    kb = size / 1024.0
    flag = "" if (tris <= 6000 and size < 300 * 1024) else "  <-- REVISAR"
    print("-" * 60)
    print("  nube  tris=%-5d  %6.1f KB  vgroups=%d  %s%s" % (
        tris, kb, len(body.vertex_groups), "thumb ok" if thumb else "sin thumb", flag))
    print("GLB:", glb)
    if thumb:
        print("PNG:", thumb)


if __name__ == "__main__":
    main()
