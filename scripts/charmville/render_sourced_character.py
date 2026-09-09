import bpy, math, sys
from mathutils import Vector
scene=bpy.context.scene
if bpy.context.object and bpy.context.object.mode!='OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
for obj in list(bpy.data.objects):
    if obj.type in {'CAMERA','LIGHT'}: bpy.data.objects.remove(obj,do_unlink=True)
rig=next(o for o in bpy.data.objects if o.type=='ARMATURE')
rig.animation_data_create(); rig.animation_data.action=bpy.data.actions.get('Idle')
scene.frame_set(1)
palette={'Skin':(.62,.32,.19,1),'Shirt':(.20,.31,.075,1),'Pants':(.22,.12,.055,1),'Hair':(.19,.075,.035,1),'Belt':(.15,.08,.04,1),'Face':(1,.94,.78,1)}
for material in bpy.data.materials:
    material.use_nodes=True
    material.node_tree.nodes.clear()
    output=material.node_tree.nodes.new('ShaderNodeOutputMaterial')
    shader=material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Base Color'].default_value=palette.get(material.name,tuple(material.diffuse_color))
    shader.inputs['Roughness'].default_value=.8
    material.node_tree.links.new(shader.outputs['BSDF'],output.inputs['Surface'])
bpy.ops.object.camera_add(location=(6,-9,6))
camera=bpy.context.object
camera.rotation_euler=(Vector((0,0,1.5))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO';camera.data.ortho_scale=4.4;scene.camera=camera
for loc,energy,size in [((-3,-4,7),500,5),((4,1,5),250,4)]:
    bpy.ops.object.light_add(type='AREA',location=loc)
    bpy.context.object.data.energy=energy;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=size
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
scene.world.color=(.3,.3,.3);scene.view_settings.view_transform='Standard'
scene.render.resolution_x=384;scene.render.resolution_y=384;scene.render.resolution_percentage=100
scene.render.film_transparent=True;scene.render.image_settings.file_format='PNG'
scene.render.filepath=sys.argv[sys.argv.index('--')+1]
if '--sheet' in sys.argv:
    from pathlib import Path
    root=Path(scene.render.filepath);root.mkdir(parents=True,exist_ok=True)
    scene.render.resolution_x=128;scene.render.resolution_y=160
    for direction in range(8):
        angle=math.radians(direction*45)
        camera.location=(0,-8,5.5)
        camera.rotation_euler=(Vector((0,0,1.5))-camera.location).to_track_quat('-Z','Y').to_euler()
        rig.rotation_euler.z=-angle
        for action,count in [('Idle',1),('Walk',8),('PickUp',8)]:
            rig.animation_data.action=bpy.data.actions[action]
            start,end=rig.animation_data.action.frame_range
            for frame in range(count):
                scene.frame_set(int(start+(end-start)*frame/(count-1 if action=='PickUp' else count)))
                directory=root/action.lower()/str(direction);directory.mkdir(parents=True,exist_ok=True)
                scene.render.filepath=str(directory/f'{frame}.png')
                bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(write_still=True)
