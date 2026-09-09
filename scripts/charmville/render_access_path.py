"""Original worn garden entrance, using the shared camera and anchored footprint."""
import sys, math, random
from pathlib import Path
import bpy
root=Path(sys.argv[sys.argv.index('--')+1]).resolve()
bpy.ops.wm.open_mainfile(filepath=str(root/'soil.blend'));bpy.context.preferences.filepaths.save_version=0
for o in list(bpy.data.objects):
    if o.type=='MESH':bpy.data.objects.remove(o,do_unlink=True)
rng=random.Random(470);vertices=[(0,0,.005)];faces=[]
for i in range(48):
    a=i*math.tau/48;r=.87+rng.uniform(-.06,.06);vertices.append((math.cos(a)*r,math.sin(a)*r,.003))
for i in range(48):faces.append((0,1+i,1+(i+1)%48))
mesh=bpy.data.meshes.new('Soft irregular worn edge');mesh.from_pydata(vertices,[],faces)
m=bpy.data.materials.new('Packed earth');m.use_nodes=True;b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=(.25,.18,.07,1);b.inputs['Roughness'].default_value=1
n=m.node_tree.nodes;l=m.node_tree.links;noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=18
bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.18;bump.inputs['Distance'].default_value=.025;l.new(noise.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],b.inputs['Normal'])
geometry=n.new('ShaderNodeNewGeometry');radius=n.new('ShaderNodeVectorMath');radius.operation='LENGTH';l.new(geometry.outputs['Position'],radius.inputs[0])
fade=n.new('ShaderNodeMapRange');fade.inputs['From Min'].default_value=.5;fade.inputs['From Max'].default_value=.9;l.new(radius.outputs['Value'],fade.inputs['Value'])
transparent=n.new('ShaderNodeBsdfTransparent');mix=n.new('ShaderNodeMixShader');l.new(fade.outputs['Result'],mix.inputs[0]);l.new(b.outputs['BSDF'],mix.inputs[1]);l.new(transparent.outputs[0],mix.inputs[2]);l.new(mix.outputs[0],n.get('Material Output').inputs['Surface'])
mesh.materials.append(m);o=bpy.data.objects.new('Foot-worn entrance',mesh);bpy.context.scene.collection.objects.link(o)
stone=bpy.data.materials.new('Warm worn stones');stone.diffuse_color=(.33,.29,.19,1)
for i in range(24):
    a=rng.random()*math.tau;r=rng.uniform(.45,.88)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=(math.cos(a)*r,math.sin(a)*r,.009));o=bpy.context.object;o.scale=(rng.uniform(.018,.045),rng.uniform(.018,.035),.01);o.data.materials.append(stone)
scene=bpy.context.scene;scene.cycles.samples=32;scene.render.filepath=str(root/'access-path.png');bpy.ops.wm.save_as_mainfile(filepath=str(root/'access-path.blend'));bpy.ops.render.render(write_still=True)
