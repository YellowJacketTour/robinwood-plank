"""Original Charmville crop models and transparent sprite animation.
Run: blender --background --python scripts/charmville/render_crops.py -- --output public/images/charmville/original
Geometry is authored here, not copied from reference game code or models.
Camera/anchor contract follows the documented 2:1 model-to-sprite workflow.
"""
import argparse, json, math, random, sys
from pathlib import Path
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

args = argparse.ArgumentParser()
args.add_argument("--output", required=True)
args.add_argument("--frames", type=int, default=8)
args.add_argument("--species", choices=["stalk", "splinter", "all"], default="all")
opts = args.parse_args(sys.argv[sys.argv.index("--")+1:])
out = Path(opts.output).resolve(); out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.render.resolution_x = 256; scene.render.resolution_y = 192; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"; scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
scene.view_settings.view_transform = "Standard"
scene.world.color = (0.35, 0.35, 0.35)
bpy.ops.object.camera_add(location=(6,-6,4.899))
camera=bpy.context.object; camera.name="Charmville_2_to_1_camera"; camera.data.type="ORTHO"; camera.data.ortho_scale=3.65
camera.rotation_euler=(Vector((0,0,0.32))-camera.location).to_track_quat("-Z","Y").to_euler();scene.camera=camera
# Adjust camera position to preserve exactly 30 degrees above the ground, aiming at the crop centre.
camera.location.z=4.899+0.32
camera.rotation_euler=(Vector((0,0,0.32))-camera.location).to_track_quat("-Z","Y").to_euler()
bpy.ops.object.light_add(type="AREA",location=(-3,-4,7));bpy.context.object.data.energy=450;bpy.context.object.data.shape="DISK";bpy.context.object.data.size=4
bpy.ops.object.light_add(type="AREA",location=(3,2,5));bpy.context.object.data.energy=180;bpy.context.object.data.size=5

def material(name,colour):
    m=bpy.data.materials.new(name);m.diffuse_color=(*colour,1);m.use_nodes=True
    bsdf=m.node_tree.nodes.get("Principled BSDF");bsdf.inputs["Base Color"].default_value=(*colour,1);bsdf.inputs["Roughness"].default_value=.8
    return m
mats=[material("leaf",(.19,.40,.045)),material("fresh stem",(.31,.52,.07)),material("ripe straw",(.63,.43,.105)),material("ripe grain",(.96,.69,.12)),material("bark",(.24,.11,.035)),material("cut wood",(.68,.44,.17)),material("charm expression",(.025,.012,.006))]

# Direct mesh construction keeps the source small and deterministic, with no external model dependency.
def build(species,stage):
    rng=random.Random(1979);vertices=[];faces=[];indices=[]
    def poly(points,mat):
        start=len(vertices);vertices.extend(points);faces.append(tuple(range(start,start+len(points))));indices.append(mat)
    def tube(a,b,r,mat,sides=6):
        a=Vector(a);b=Vector(b);axis=(b-a).normalized();u=axis.cross(Vector((0,1,0))).normalized();v=axis.cross(u)
        rings=[[tuple(c+r*(math.cos(i*math.tau/sides)*u+math.sin(i*math.tau/sides)*v)) for i in range(sides)] for c in [a,b]]
        for i in range(sides):poly([rings[0][i],rings[0][(i+1)%sides],rings[1][(i+1)%sides],rings[1][i]],mat)
        poly(rings[1],5 if species=="splinter" else mat)
    def kernel(x,y,z,angle,mat):
        # Compact pointed grain, lit on six facets.
        r=.034;h=.058
        ring=[(x+math.cos(i*math.tau/6+angle)*r,y+math.sin(i*math.tau/6+angle)*r,z) for i in range(6)]
        for i in range(6):poly([ring[i],ring[(i+1)%6],(x,y,z+h)],mat)
    count=(5 if stage<.5 else 11) if species=="stalk" else 4
    for row in range(count):
        for col in range(count):
            x=-.85+col*1.7/(count-1)+rng.uniform(-.03,.03);y=-.85+row*1.7/(count-1)+rng.uniform(-.03,.03)
            h=rng.uniform(.40,.64)*stage;lean=rng.uniform(-.065,.065)
            if species=="stalk":
                tube((x,y,0),(x+lean,y,h),.008,2 if stage>.8 else 1)
                for side in [-1,1]:
                    z=h*.36;reach=.20 if stage<.5 else .23*stage;poly([(x,y,z),(x+side*reach*.5,y+.065,z+.07),(x+side*reach,y,z+.12),(x+side*reach*.5,y-.065,z+.045)],1 if stage<.5 else 0)
                if stage>.45:
                    for k in range(5):
                        z=h-.015+k*.025*stage
                        for side in [-1,1]:kernel(x+lean+side*.015,y,z,rng.random(),3 if stage>.8 else 1)
                    tube((x+lean,y,h+.08*stage),(x+lean,y,h+.15*stage),.002,2 if stage>.8 else 1,3)
            else:
                tube((x,y,0),(x+lean,y,h),.032 if stage<.5 else .065,4)
                if stage>.8:
                    # A broad split timber crown links the ripe plant to its harvested charm.
                    cx=x+lean;lo=h*.46;hi=h+.1;w=.115;d=.075
                    poly([(cx-w,y-d,lo),(cx+w,y-d,lo),(cx+w*.8,y-d,hi-.025),(cx-w*.6,y-d,hi)],5)
                    poly([(cx+w,y-d,lo),(cx+w,y+d,lo),(cx+w*.8,y+d,hi-.025),(cx+w*.8,y-d,hi-.025)],4)
                    poly([(cx-w,y+d,lo),(cx-w,y-d,lo),(cx-w*.6,y-d,hi),(cx-w*.6,y+d,hi)],4)
                    poly([(cx-w*.6,y-d,hi),(cx+w*.8,y-d,hi-.025),(cx+w*.8,y+d,hi-.025),(cx-w*.6,y+d,hi)],5)
                    for eye in [-.04,.04]:
                        ex=cx+eye;ez=h*.88
                        poly([(ex-.013,y-d-.002,ez-.018),(ex+.013,y-d-.002,ez-.018),(ex+.013,y-d-.002,ez+.018),(ex-.013,y-d-.002,ez+.018)],6)
                    poly([(cx-.024,y-d-.003,h*.76),(cx,y-d-.003,h*.73),(cx+.024,y-d-.003,h*.76),(cx,y-d-.003,h*.71)],6)
                for side in [-1,1]:
                    bx=x+side*.11*stage;by=y+.035;z=h*.72
                    tube((x,y,h*.4),(bx,by,z),.013,4)
                    poly([(bx,by,z),(bx+side*.16*stage,by+.045,z+.1*stage),(bx+side*.06,by+.1,z+.045)],0)
    mesh=bpy.data.meshes.new(species);mesh.from_pydata(vertices,[],faces);mesh.materials.clear()
    for m in mats:mesh.materials.append(m)
    for f,i in zip(mesh.polygons,indices):f.material_index=i
    obj=bpy.data.objects.new(species,mesh);scene.collection.objects.link(obj)
    return obj,[v.co.copy() for v in mesh.vertices]

manifest={"generator":"scripts/charmville/render_crops.py","blender":bpy.app.version_string,"projection":"orthographic 2:1","frameSize":[256,192],"frames":opts.frames,"fps":8,"species":{}}
anchor=world_to_camera_view(scene,camera,Vector((0,0,0)))
manifest["anchor"]=[round(anchor.x*256,3),round((1-anchor.y)*192,3)]
for species in (["stalk","splinter"] if opts.species=="all" else [opts.species]):
    manifest["species"][species]={}
    for name,scale in [("seedling",.4),("growing",.7),("ripe",1.0)]:
        obj,base=build(species,scale);folder=out/species/name;folder.mkdir(parents=True,exist_ok=True)
        for frame in range(opts.frames):
            phase=frame*math.tau/opts.frames
            for v,co in zip(obj.data.vertices,base):
                v.co=co.copy();v.co.x+=math.sin(phase+co.x*.5+co.y*.4)*co.z*co.z*.035
            obj.data.update();scene.render.filepath=str(folder/f"{frame:02d}.png");bpy.ops.render.render(write_still=True)
        manifest["species"][species][name]=[f"{species}/{name}/{f:02d}.png" for f in range(opts.frames)]
        if name=="ripe":bpy.ops.wm.save_as_mainfile(filepath=str(out/f"{species}.blend"))
        bpy.data.objects.remove(obj,do_unlink=True)
# Broad modeled furrows replace fine borrowed soil detail that hid seedlings.
vertices=[];faces=[];steps=48
for y in range(steps+1):
    for x in range(steps+1):
        px=-.95+x*1.9/steps;py=-.95+y*1.9/steps
        # Broad ridges with restrained deterministic clods; seedlings stay legible.
        clod=.006*math.sin(x*2.17+y*.81)*math.sin(y*1.71-x*.47)
        vertices.append((px,py,.015+.026*math.cos(y/steps*7*math.tau)+clod))
for y in range(steps):
    for x in range(steps):
        a=y*(steps+1)+x;faces.append((a,a+1,a+steps+2,a+steps+1))
mesh=bpy.data.meshes.new('seven broad soil furrows');mesh.from_pydata(vertices,[],faces)
earth=material('warm cultivated earth',(.21,.086,.029));mesh.materials.append(earth)
nodes=earth.node_tree.nodes;links=earth.node_tree.links
noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=32;noise.inputs['Detail'].default_value=2
bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.16;bump.inputs['Distance'].default_value=.018
links.new(noise.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
soil=bpy.data.objects.new('cultivated soil',mesh);scene.collection.objects.link(soil)
scene.render.filepath=str(out/'soil.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'soil.blend'));bpy.data.objects.remove(soil,do_unlink=True)
# Periodic 4D-noise turf: UV edges join on a torus, so no diamond seams are baked in.
bpy.ops.mesh.primitive_plane_add(size=2);turf=bpy.context.object
# Overscan the plane while preserving the visible 0..1 UV domain. This avoids
# transparent antialiasing at tile edges when the browser repeats the image.
turf.scale=(1.02,1.02,1)
for loop in turf.data.uv_layers.active.data:
    loop.uv=(loop.uv-Vector((.5,.5)))*1.02+Vector((.5,.5))
m=material('seamless miniature turf',(.16,.28,.06));turf.data.materials.append(m)
n=m.node_tree.nodes;links=m.node_tree.links;uv=n.new('ShaderNodeTexCoord');sep=n.new('ShaderNodeSeparateXYZ');links.new(uv.outputs['UV'],sep.inputs[0])
channels=[]
for axis in ['X','Y']:
    angle=n.new('ShaderNodeMath');angle.operation='MULTIPLY';angle.inputs[1].default_value=math.tau;links.new(sep.outputs[axis],angle.inputs[0])
    for operation in ['SINE','COSINE']:
        node=n.new('ShaderNodeMath');node.operation=operation;links.new(angle.outputs[0],node.inputs[0]);channels.append(node.outputs[0])
vector=n.new('ShaderNodeCombineXYZ')
for index in range(3):links.new(channels[index],vector.inputs[index])
noise=n.new('ShaderNodeTexNoise');noise.noise_dimensions='4D';noise.inputs['Scale'].default_value=4;noise.inputs['Detail'].default_value=3
links.new(vector.outputs[0],noise.inputs['Vector']);links.new(channels[3],noise.inputs['W'])
ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.105,.20,.035,1);ramp.color_ramp.elements[1].color=(.17,.29,.055,1)
links.new(noise.outputs['Fac'],ramp.inputs['Fac']);links.new(ramp.outputs['Color'],n.get('Principled BSDF').inputs['Base Color'])
emission=n.new('ShaderNodeEmission');links.new(ramp.outputs['Color'],emission.inputs['Color']);links.new(emission.outputs[0],n.get('Material Output').inputs['Surface'])
camera.location=(0,0,5);camera.rotation_euler=(0,0,0);camera.data.ortho_scale=2
scene.render.resolution_y=256;scene.render.filepath=str(out/'turf.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'turf.blend'))
(out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
