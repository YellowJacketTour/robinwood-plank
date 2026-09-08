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
mats=[material("leaf",(.19,.40,.045)),material("fresh stem",(.31,.52,.07)),material("ripe straw",(.63,.43,.105)),material("ripe grain",(.96,.69,.12)),material("bark",(.24,.11,.035)),material("cut wood",(.68,.44,.17))]

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
    count=11 if species=="stalk" else 4
    for row in range(count):
        for col in range(count):
            x=-.85+col*1.7/(count-1)+rng.uniform(-.03,.03);y=-.85+row*1.7/(count-1)+rng.uniform(-.03,.03)
            h=rng.uniform(.40,.64)*stage;lean=rng.uniform(-.065,.065)
            if species=="stalk":
                tube((x,y,0),(x+lean,y,h),.008,2 if stage>.8 else 1)
                for side in [-1,1]:
                    z=h*.36;poly([(x,y,z),(x+side*.08,y+.04,z+.06*stage),(x+side*.23*stage,y,z+.13*stage),(x+side*.05,y-.03,z+.025)],0)
                if stage>.45:
                    for k in range(5):
                        z=h-.015+k*.025*stage
                        for side in [-1,1]:kernel(x+lean+side*.015,y,z,rng.random(),3 if stage>.8 else 1)
                    tube((x+lean,y,h+.08*stage),(x+lean,y,h+.15*stage),.002,2 if stage>.8 else 1,3)
            else:
                tube((x,y,0),(x+lean,y,h),.032,4)
                for side in [-1,1]:
                    bx=x+side*.11*stage;by=y+.035;z=h*.72
                    tube((x,y,h*.4),(bx,by,z),.013,4)
                    poly([(bx,by,z),(bx+side*.09*stage,by+.025,z+.06*stage),(bx+side*.035,by+.06,z+.025)],0)
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
    for name,scale in [("seedling",.25),("growing",.6),("ripe",1.0)]:
        obj,base=build(species,scale);folder=out/species/name;folder.mkdir(parents=True,exist_ok=True)
        for frame in range(opts.frames):
            phase=frame*math.tau/opts.frames
            for v,co in zip(obj.data.vertices,base):
                v.co=co.copy();v.co.x+=math.sin(phase+co.x*.5+co.y*.4)*co.z*co.z*.035
            obj.data.update();scene.render.filepath=str(folder/f"{frame:02d}.png");bpy.ops.render.render(write_still=True)
        manifest["species"][species][name]=[f"{species}/{name}/{f:02d}.png" for f in range(opts.frames)]
        if name=="ripe":bpy.ops.wm.save_as_mainfile(filepath=str(out/f"{species}.blend"))
        bpy.data.objects.remove(obj,do_unlink=True)
(out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
