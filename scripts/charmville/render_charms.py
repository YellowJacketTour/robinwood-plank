"""Original sculpted Charmville portraits; deterministic editable Blender sources.
blender --background --python scripts/charmville/render_charms.py -- --output public/images/charmville/charms
"""
import argparse, math, sys
from pathlib import Path
import bpy
from mathutils import Vector

parser=argparse.ArgumentParser(); parser.add_argument('--output',required=True)
out=Path(parser.parse_args(sys.argv[sys.argv.index('--')+1:]).output).resolve();out.mkdir(parents=True,exist_ok=True)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=40;scene.cycles.use_denoising=True
scene.render.resolution_x=256;scene.render.resolution_y=256;scene.render.resolution_percentage=100
scene.render.film_transparent=True;scene.render.image_settings.color_mode='RGBA';scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
bpy.ops.object.camera_add(location=(.25,-7,2.8));camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=3.25
camera.rotation_euler=(Vector((0,0,1.25))-camera.location).to_track_quat('-Z','Y').to_euler();scene.camera=camera
for loc,power,size in [((-3,-4,6),500,4),((3,-2,3),170,3),((1,3,5),350,3)]:
    bpy.ops.object.light_add(type='AREA',location=loc);bpy.context.object.data.energy=power;bpy.context.object.data.size=size
def mat(name,color,rough=.5,grain=False,metal=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;n=m.node_tree.nodes;b=n.get('Principled BSDF')
    b.inputs['Base Color'].default_value=(*color,1);b.inputs['Roughness'].default_value=rough;b.inputs['Metallic'].default_value=metal
    if grain:
        tex=n.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=14;tex.inputs['Detail'].default_value=2
        bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.18;bump.inputs['Distance'].default_value=.035
        m.node_tree.links.new(tex.outputs['Fac'],bump.inputs['Height']);m.node_tree.links.new(bump.outputs['Normal'],b.inputs['Normal'])
    return m
gold=mat('Warm cereal gold',(.82,.48,.07),grain=True);leaf=mat('Satin leaf',(.12,.31,.035));wood=mat('Carved honey wood',(.43,.19,.055),grain=True)
cut=mat('Fresh end grain',(.74,.44,.17),grain=True);dark=mat('Espresso eyes',(.018,.009,.005),.27);cream=mat('Eye glints',(.98,.87,.6),.2)
rose=mat('Warm cheeks',(.63,.17,.075));metal=mat('Polished brass',(.85,.54,.13),.28,metal=.65)
base=set(bpy.data.objects)
def ell(name,loc,scale,material):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=20,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;o.data.materials.append(material)
    for p in o.data.polygons:p.use_smooth=True
    return o
def curve(name,points,radius,material):
    c=bpy.data.curves.new(name,'CURVE');c.dimensions='3D';c.bevel_depth=radius;c.bevel_resolution=4;s=c.splines.new('BEZIER');s.bezier_points.add(len(points)-1)
    for b,p in zip(s.bezier_points,points):b.co=p;b.handle_left_type='AUTO';b.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,c);scene.collection.objects.link(o);c.materials.append(material);return o
def box(name,loc,scale,material,bevel=.15):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(material);m=o.modifiers.new('Hand softened edges','BEVEL');m.width=bevel;m.segments=5;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');return o
def face(z,y=-.4,w=.22):
    for x in [-w,w]:
        ell('Inlaid eye',(x,y,z),(.065,.035,.085),dark);ell('Eye light',(x-.017,y-.033,z+.025),(.018,.012,.023),cream)
        ell('Cheek',(x*1.6,y+.025,z-.12),(.09,.021,.042),rose)
    curve('Friendly smile',[(-.12,y-.01,z-.18),(0,y-.035,z-.225),(.12,y-.01,z-.18)],.025,dark)
for name in ['stalk','splinter','knock','hum','pith','gleam','knot']:
    if name=='stalk':
        curve('Stem',[(0,0,.25),(0,0,1.2),(0,0,2.5)],.055,gold)
        for side in [-1,1]:
            o=ell('Broad leaf',(side*.36,0,.65),(.2,.075,.58),leaf);o.rotation_euler.y=side*.8
        for row in range(5):
            for side in [-1,1]:
                o=ell('Sculpted grain',(side*(.22 if row<4 else .14),0,1.1+row*.26),(.25,.24,.32),gold);o.rotation_euler.y=side*.5
        face(1.5,-.25,.19)
    elif name=='splinter':
        o=box('Irregular timber charm',(0,0,1.25),(.92,.58,1.7),wood);o.rotation_euler.y=-.16
        box('Fresh chipped edge',(.04,-.02,2.08),(.7,.49,.12),cut,.045)
        for x in [-.31,.27]:curve('Carved grain',[(x,-.303,.65),(x+.04,-.308,1.1),(x-.04,-.308,1.8)],.012,cut)
        face(1.38,-.33)
    elif name=='knock':
        box('Mallet handle',(0,0,.75),(.27,.3,1.25),wood,.1);box('Mallet head',(0,0,1.85),(1.55,.65,.8),cut,.2);face(1.92,-.35,.25)
    elif name=='hum':
        box('Radio cabinet',(0,0,1.25),(1.5,.65,1.6),wood,.24);box('Speaker grille',(0,-.34,.95),(1.08,.07,.5),dark,.09)
        for x in range(7):curve('Brass grille',[(x*.13-.39,-.39,.77),(x*.13-.39,-.39,1.12)],.017,metal)
        curve('Carry handle',[(-.43,0,2.04),(-.35,0,2.35),(.35,0,2.35),(.43,0,2.04)],.065,metal);face(1.65,-.36,.28)
    elif name=='pith':
        ell('Heartwood fruit',(0,0,1.2),(.83,.4,.85),gold);ell('Cut heart',(0,-.3,1.25),(.68,.17,.67),cut);face(1.42,-.48,.23)
        o=ell('Fruit leaf',(.25,0,2.08),(.35,.075,.14),leaf);o.rotation_euler.y=-.4
    elif name=='gleam':
        points=[]
        for i in range(80):
            t=i/79*math.tau*1.35;r=.18+i/79*.65;points.append((math.cos(t)*r,0,1.3+math.sin(t)*r))
        curve('Curled wood shaving',points,.17,metal);face(1.4,-.17,.19)
        for x,z in [(-.78,2.2),(.8,2.35)]:
            curve('Sparkle upright',[(x,0,z-.18),(x,0,z+.18)],.025,metal);curve('Sparkle cross',[(x-.11,0,z),(x+.11,0,z)],.025,metal)
    else:
        ell('Knot body',(0,0,1.3),(.87,.34,.92),wood)
        for r in [.7,.53,.37]:curve('Growth ring',[(math.cos(t)*r,-.3,1.3+math.sin(t)*r*1.07) for t in [i*math.tau/48 for i in range(49)]],.032,cut)
        face(1.44,-.36,.21)
    scene.render.filepath=str(out/f'{name}.png');bpy.ops.wm.save_as_mainfile(filepath=str(out/f'{name}.blend'));bpy.ops.render.render(write_still=True)
    for o in list(bpy.data.objects):
        if o not in base:bpy.data.objects.remove(o,do_unlink=True)
