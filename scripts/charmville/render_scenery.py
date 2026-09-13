"""Render Kenney CC0 tree meshes in Charmville's crop camera and natural palette.
blender --background --python scripts/charmville/render_scenery.py -- --root public/images/charmville/kenney
"""
import argparse, json, sys, random, math
from pathlib import Path
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

p=argparse.ArgumentParser();p.add_argument('--root',required=True)
root=Path(p.parse_args(sys.argv[sys.argv.index('--')+1:]).root).resolve()
bpy.context.preferences.filepaths.save_version=0
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32
scene.cycles.use_denoising=True;scene.render.film_transparent=True
scene.render.resolution_x=256;scene.render.resolution_y=192;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.view_settings.view_transform='Standard';scene.world.color=(.35,.35,.35)
bpy.ops.object.camera_add(location=(6,-6,5.499));camera=bpy.context.object
camera.data.type='ORTHO';camera.data.ortho_scale=3.65
camera.rotation_euler=(Vector((0,0,.6))-camera.location).to_track_quat('-Z','Y').to_euler();scene.camera=camera
for position,energy,size in [((-3,-4,7),450,4),((3,2,5),180,5)]:
    bpy.ops.object.light_add(type='AREA',location=position);bpy.context.object.data.energy=energy;bpy.context.object.data.size=size
anchor=world_to_camera_view(scene,camera,Vector((0,0,0)))
for name in ['tree_oak','tree_detailed','tree_plateau']:
    bpy.ops.wm.obj_import(filepath=str(root/'models'/f'{name}.obj'))
    objects=list(bpy.context.selected_objects)
    for obj in objects:
        modifier=obj.modifiers.new("Soft foliage silhouette","SUBSURF");modifier.levels=1;modifier.render_levels=2
        for polygon in obj.data.polygons: polygon.use_smooth=True
        for material in obj.data.materials:
            material.use_nodes=True;nodes=material.node_tree.nodes;bsdf=nodes.get('Principled BSDF')
            leaf='leaf' in material.name.lower()
            colour=(.25,.46,.065,1) if leaf else (.32,.14,.055,1)
            bsdf.inputs['Base Color'].default_value=colour;bsdf.inputs['Roughness'].default_value=.9
            if leaf:
                noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=7
                ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.16,.30,.04,1);ramp.color_ramp.elements[1].color=(.38,.57,.09,1)
                material.node_tree.links.new(noise.outputs['Fac'],ramp.inputs['Fac']);material.node_tree.links.new(ramp.outputs['Color'],bsdf.inputs['Base Color'])
    # Retain the sourced trunk/crown structure; author small leaf masses on its
    # evaluated foliage surface so silhouette and recesses read at sprite scale.
    rng=random.Random(1979);leaf_vertices=[];leaf_faces=[]
    for obj in list(objects):
        evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        candidates=[tri for tri in mesh.loop_triangles if 'leaf' in obj.data.materials[tri.material_index].name.lower()]
        if not candidates:evaluated.to_mesh_clear();continue
        for n in range(480):
            tri=rng.choice(candidates);a,b,c=[obj.matrix_world@mesh.vertices[index].co for index in tri.vertices]
            u=rng.random();v=rng.random()*(1-u);centre=a*u+b*v+c*(1-u-v)
            normal=(b-a).cross(c-a).normalized();centre+=normal*.013
            tangent=normal.cross(Vector((0,0,1)))
            if tangent.length<.01:tangent=Vector((1,0,0))
            tangent.normalize();side=normal.cross(tangent).normalized()
            length=rng.uniform(.025,.06);width=length*.6
            start=len(leaf_vertices)
            leaf_vertices.extend([centre-tangent*length,centre+side*width,centre+tangent*length,centre-side*width,centre+normal*.012])
            leaf_faces.extend([(start,start+1,start+4),(start+1,start+2,start+4),(start+2,start+3,start+4),(start+3,start,start+4)])
        evaluated.to_mesh_clear()
    mesh=bpy.data.meshes.new(name+'_leaves');mesh.from_pydata(leaf_vertices,[],leaf_faces)
    leaf=bpy.data.objects.new(name+'_leaves',mesh);scene.collection.objects.link(leaf)
    for obj in objects:
        material=next((m for m in obj.data.materials if 'leaf' in m.name.lower()),None)
        if material:mesh.materials.append(material);break
    objects.append(leaf)
    scene.render.filepath=str(root/f'{name}.png');bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(root/f'{name}.blend'))
    for obj in objects:bpy.data.objects.remove(obj,do_unlink=True)
(root/'scenery.json').write_text(json.dumps({'author':'Kenney','source':'https://kenney.nl/assets/nature-kit','license':'CC0','modified':'Sourced trunk/crowns with authored leaf masses, natural materials, subdivision and shared crop camera','frameSize':[256,192],'anchor':[round(anchor.x*256,3),round((1-anchor.y)*192,3)]},indent=2)+'\n')
