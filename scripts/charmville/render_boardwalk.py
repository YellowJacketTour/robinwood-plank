"""Render broad timber boards in the existing crop camera, with editable source."""
import sys, math
from pathlib import Path
import bpy
root=Path(sys.argv[sys.argv.index('--')+1]).resolve()
bpy.ops.wm.open_mainfile(filepath=str(root/'soil.blend'))
bpy.context.preferences.filepaths.save_version=0
for obj in list(bpy.data.objects):
    if obj.type=='MESH':bpy.data.objects.remove(obj,do_unlink=True)
scene=bpy.context.scene;scene.cycles.samples=32
def material(index):
    m=bpy.data.materials.new('Weathered timber '+str(index));m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links;b=n.get('Principled BSDF')
    b.inputs['Roughness'].default_value=.87
    coord=n.new('ShaderNodeTexCoord');mapping=n.new('ShaderNodeVectorMath');mapping.operation='MULTIPLY';mapping.inputs[1].default_value=(1,28,4);l.new(coord.outputs['Generated'],mapping.inputs[0])
    noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=3;noise.inputs['Detail'].default_value=2;l.new(mapping.outputs['Vector'],noise.inputs['Vector'])
    ramp=n.new('ShaderNodeValToRGB');t=index*.018;ramp.color_ramp.elements[0].color=(.21+t,.105+t,.04+t,1);ramp.color_ramp.elements[1].color=(.37+t,.23+t,.11+t,1)
    l.new(noise.outputs['Fac'],ramp.inputs['Fac']);l.new(ramp.outputs['Color'],b.inputs['Base Color'])
    bump=n.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.12;bump.inputs['Distance'].default_value=.025;l.new(noise.outputs['Fac'],bump.inputs['Height']);l.new(bump.outputs['Normal'],b.inputs['Normal']);return m
for i in range(5):
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,-.8+i*.4,.025));o=bpy.context.object;o.name='Broad fitted board';o.scale=(2,.385,.07)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material(i%3))
    bevel=o.modifiers.new('Worn edges','BEVEL');bevel.width=.018;bevel.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
scene.render.filepath=str(root/'boardwalk.png');bpy.ops.wm.save_as_mainfile(filepath=str(root/'boardwalk.blend'));bpy.ops.render.render(write_still=True)
