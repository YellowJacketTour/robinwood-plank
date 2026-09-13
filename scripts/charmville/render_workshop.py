"""Original Charmville workshop: editable seed cottage and botanical orchard trees.
Run Blender 4.5: --background --python scripts/charmville/render_workshop.py -- --root public/images/charmville/workshop
All meshes are authored here; no third-party character or game artwork is included.
"""
import bpy, math, random, json, sys, argparse, hashlib
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--only',choices=['all','turf'],default='all');args=p.parse_args(sys.argv[sys.argv.index('--')+1:]);root=Path(args.root).resolve();root.mkdir(parents=True,exist_ok=True)
bpy.context.preferences.filepaths.save_version=0
rng=random.Random(43017)
def mat(name,c,rough=.78,metal=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*c,1);m.use_nodes=True;b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=(*c,1);b.inputs['Roughness'].default_value=rough;b.inputs['Metallic'].default_value=metal;return m
wood=mat('Warm carved oak',(.43,.235,.105));edge=mat('Honey endgrain',(.64,.39,.18));dark=mat('Deep joinery',(.15,.078,.038));plaster=mat('Cream limewash',(.83,.7,.45));sage=mat('Sage painted door',(.30,.43,.19));stone=mat('Weathered pale limestone',(.53,.51,.37));gold=mat('Brushed brass',(.83,.53,.14),.32,.55);glass=mat('Honey lantern glass',(.95,.64,.15),.27);glass.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value=(1,.48,.05,1);glass.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value=.8
leaves=[mat('Leaf '+str(i),c) for i,c in enumerate([(.24,.40,.075),(.35,.49,.10),(.45,.57,.16),(.53,.62,.22),(.29,.45,.12)])]
pinks=[mat('Blossom '+str(i),c) for i,c in enumerate([(.92,.49,.40),(.95,.65,.5),(.87,.39,.35),(.97,.75,.59)])]
ivory=mat('Flower ivory',(.99,.9,.66));violet=mat('Flower periwinkle',(.45,.43,.72));sky=mat('Window night blue',(.11,.21,.28),.25)
# Subtle surface microrelief belongs to the Blender material and survives source edits.
for material,scale,strength in [(wood,22,.16),(edge,26,.12),(stone,18,.12)]:
 nodes=material.node_tree.nodes;links=material.node_tree.links
 tex=nodes.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=scale;tex.inputs['Detail'].default_value=2
 bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=strength;bump.inputs['Distance'].default_value=.023
 links.new(tex.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
def mesh(name,vs,fs,m):
 d=bpy.data.meshes.new(name);d.from_pydata(vs,[],fs);d.materials.append(m);o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o);return o
def bevel(o,w=.02):
 mod=o.modifiers.new('Hand softened edges','BEVEL');mod.width=w;mod.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');return o
def box(n,loc,scale,m,b=.02,rot=None):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=n;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m)
 if rot:o.rotation_euler=rot
 if b:bevel(o,b)
 return o
def ball(n,loc,sc,m):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8,location=loc);o=bpy.context.object;o.name=n;o.scale=sc;o.data.materials.append(m)
 for f in o.data.polygons:f.use_smooth=True
 return o
def curve(n,pts,r,m):
 c=bpy.data.curves.new(n,'CURVE');c.dimensions='3D';c.resolution_u=12;c.bevel_depth=r;c.bevel_resolution=3;s=c.splines.new('BEZIER');s.bezier_points.add(len(pts)-1)
 for b,p in zip(s.bezier_points,pts):b.co=p;b.handle_left_type='AUTO';b.handle_right_type='AUTO'
 o=bpy.data.objects.new(n,c);bpy.context.collection.objects.link(o);o.data.materials.append(m);return o
def leaf(n,center,length,width,m,angle=0,tilt=0):
 # Folded lanceolate blade with a convex central vein; readable lobed outline.
 x,y,z=center;vs=[(-length*.5,0,0),(-length*.25,width*.75,.014),(0,width,.027),(length*.3,width*.6,.022),(length*.5,0,.015),(length*.3,-width*.6,.022),(0,-width,.027),(-length*.25,-width*.75,.014),(0,0,.065)]
 v=[]
 for a,b,c in vs:v.append((x+a*math.cos(angle)-b*math.sin(angle),y+a*math.sin(angle)+b*math.cos(angle),z+c+a*tilt))
 o=mesh(n,v,[(i,(i+1)%8,8) for i in range(8)],m)
 for polygon in o.data.polygons:polygon.use_smooth=True
 mod=o.modifiers.new('Rounded botanical blade','SUBSURF');mod.levels=1
 return o
def flower(x,y,z,color=ivory,size=.035):
 for j in range(5):
  a=j*math.tau/5;ball('Flower petal',(x+math.cos(a)*size,y+math.sin(a)*size,z),(size*.72,size*.7,size*.32),color)
 ball('Golden pollen',(x,y,z+.015),(size*.4,)*3,gold)
def setup():
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=48;s.cycles.use_denoising=True;s.render.film_transparent=True;s.render.image_settings.file_format='PNG';s.render.image_settings.color_mode='RGBA';s.render.resolution_x=768;s.render.resolution_y=576;s.render.resolution_percentage=100;s.view_settings.view_transform='AgX';s.world.color=(.45,.45,.45)
 bpy.ops.object.camera_add(location=(6,-6,5.499));cam=bpy.context.object;cam.data.type='ORTHO';cam.data.ortho_scale=3.65;cam.rotation_euler=(Vector((0,0,.6))-cam.location).to_track_quat('-Z','Y').to_euler();s.camera=cam
 for pos,power,size in [((-3,-4,7),650,4),((4,1,5),350,5)]:
  bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
 return s
def save(name,s):
 # Runtime ground-anchor shadows avoid the finite shadow-catcher plane becoming
 # a rectangular translucent card under the site's independently lit turf.
 # Keep object self-shadowing in Cycles; export a genuinely transparent silhouette.
 s.render.filepath=str(root/(name+'@3x.png'));bpy.ops.wm.save_as_mainfile(filepath=str(root/(name+'.blend')));bpy.ops.render.render(write_still=True)
 img=bpy.data.images.load(str(root/(name+'@3x.png')),check_existing=False);img.scale(256,192);img.filepath_raw=str(root/(name+'.png'));img.save();bpy.data.images.remove(img)
 bpy.ops.object.select_all(action='DESELECT')
 for o in s.objects:
  if o.type in ['MESH','CURVE'] and not o.is_shadow_catcher:o.select_set(True)
 bpy.ops.export_scene.gltf(filepath=str(root/(name+'.glb')),export_format='GLB',use_selection=True,export_apply=True)
 return {'image':name+'.png','image3x':name+'@3x.png','source':name+'.blend','model':name+'.glb','anchor':[128,132.444],'frameSize':[256,192]}
def cottage():
 s=setup()
 box('Stone footing',(0,0,.055),(1.3,1.05,.12),stone,.06)
 box('Cream cottage body',(0,0,.55),(1.16,.94,.93),plaster,.055)
 for x in [-.55,.55]:box('Corner timber',(x,-.48,.58),(.10,.10,1.05),wood)
 for y in [-.42,.43]:box('Side timber',(.59,y,.56),(.09,.10,1.02),wood)
 for z in [.16,.48,.88]:box('Horizontal beam',(.591,0,z),(.09,.94,.065),edge)
 for i in range(11):
  x=-.50+i*.10;box('Front oak plank',(x,-.482,.53),(.094,.055,.80),edge if i%3==0 else wood,.01)
 for i in range(9):box('Side weatherboard',(.606,-.4+i*.1,.52),(.045,.094,.83),edge if i%3==0 else wood,.008)
 # Gable and roof strips: actual individually overlapping curved shingles.
 mesh('Front gable',[(-.62,-.51,1),(.62,-.51,1),(0,-.51,1.64)],[(0,1,2)],wood)
 for side in [-1,1]:
  curve('Carved eave',[(0,-.62,1.69),(side*.36,-.62,1.40),(side*.75,-.62,1.03)],.053,edge)
  for row in range(5):
   x=side*(.08+row*.14);z=1.63-row*.123
   for col in range(9):
    y=-.59+col*.14+(row%2)*.025;sh=box('Moss roof shingle',(x,y,z),(.24,.16,.058),leaves[(col+row)%5],.026);sh.rotation_euler.y=side*.73
  curve('Roof verge',[(side*.74,-.60,1.01),(side*.76,0,1.03),(side*.74,.60,1.01)],.045,wood)
 curve('Roof ridge',[(0,-.64,1.7),(0,0,1.73),(0,.60,1.69)],.054,edge)
 # Sage plank door, arched trim, hinges and ring pull.
 box('Door recess',(-.12,-.535,.47),(.5,.045,.73),dark,.025)
 for i in range(5):box('Sage door board',(-.31+i*.095,-.57,.46),(.091,.048,.68),sage,.014)
 for x in [-.39,.16]:box('Door jamb',(x,-.59,.49),(.07,.07,.82),edge)
 box('Door lintel',(-.115,-.59,.88),(.64,.07,.095),edge)
 for z in [.25,.65]:box('Forged hinge',(-.29,-.603,z),(.11,.02,.025),dark,.009)
 bpy.ops.mesh.primitive_torus_add(major_radius=.040,minor_radius=.009,major_segments=20,minor_segments=8,location=(.025,-.62,.47),rotation=(math.pi/2,0,0));bpy.context.object.data.materials.append(gold)
 ball('Door brass stud',(.025,-.63,.51),(.018,.015,.018),gold)
 box('Stone doorstep',(-.1,-.7,.085),(.72,.32,.12),stone,.045)
 # Gable star plaque and side glazed crosslight.
 box('Star plaque',(-.08,-.552,1.12),(.55,.04,.22),sky,.05)
 vs=[]
 for j in range(10):
  a=math.pi/2+j*math.pi/5;r=.088 if j%2==0 else .037;vs.append((-.08+math.cos(a)*r,-.58,1.12+math.sin(a)*r))
 mesh('Brass guiding star',vs,[tuple(range(10))],gold)
 box('Side window frame',(.65,.07,.66),(.07,.39,.42),edge,.025);box('Side window glass',(.692,.07,.67),(.016,.3,.32),sky,.01)
 box('Window mullion',(.71,.07,.67),(.025,.025,.35),edge);box('Window transom',(.71,.07,.67),(.025,.32,.026),edge)
 box('Window flower box',(.74,.07,.40),(.23,.46,.14),wood,.018)
 for i in range(9):
  y=-.10+i*.044;leaf('Window garden',(.77,y,.49),.16,.044,leaves[i%5],rng.random()*6);flower(.78,y,.55,ivory if i%2 else pinks[0],.024)
 # Lantern: glowing glass, framed cage, pitched hat, hanging hook.
 lx,ly=.38,-.65
 box('Lantern wall foot',(.38,-.55,.86),(.055,.06,.15),dark)
 curve('Lantern curved hook',[(.38,-.54,.94),(.38,-.68,1.01),(.38,-.69,.94)],.011,dark)
 box('Lantern glass',(lx,ly,.80),(.10,.10,.17),glass,.018)
 for dx in [-.055,.055]:
  for dy in [-.055,.055]:box('Lantern brass rib',(lx+dx,ly+dy,.80),(.012,.012,.2),gold,.004)
 for z in [.695,.905]:box('Lantern cap',(lx,ly,z),(.15,.15,.035),dark,.015)
 # Hearth chimney with mortared blocks and open flue.
 for row in range(4):
  for col in range(2):box('Chimney stone',(.28+col*.14,.28,1.39+row*.115),(.135,.23,.105),stone,.018)
 box('Chimney crown',(.35,.28,1.86),(.37,.32,.07),stone,.025);box('Chimney dark flue',(.35,.28,1.902),(.23,.18,.008),dark,.012)
 # Selective roof vines and flowers without carpet noise.
 for i in range(44):
  side=rng.choice([-1,1]);x=side*rng.uniform(.3,.67);y=rng.uniform(-.52,.52);z=1.66-abs(x)*.86
  leaf('Roof ivy',(x,y,z+.04),rng.uniform(.10,.16),.035,leaves[i%5],rng.random()*6)
  if i%8==0:flower(x,y,z+.09,ivory,.027)
 return save('seed-cottage',s)
def tree(name,pink=False):
 s=setup()
 # Curved tapering trunk skin from rings; root flares and shaped branches.
 rings=[(0,0,0,.17),(-.015,0,.12,.115),(.015,0,.43,.085),(-.04,.02,.72,.07),(.02,0,1.09,.045)]
 vs=[]
 for x,y,z,r in rings:
  for i in range(12):
   a=i*math.tau/12;vs.append((x+math.cos(a)*r*(1+.11*math.sin(i*3)),y+math.sin(a)*r,z))
 fs=[]
 for j in range(4):
  for i in range(12):a=j*12+i;b=j*12+(i+1)%12;fs.append((a,b,b+12,a+12))
 trunk=mesh('Sculpted orchard trunk',vs,fs,wood);bevel(trunk,.018)
 for j in range(6):
  a=j*math.tau/6;curve('Grounded root',[(math.cos(a)*.26,math.sin(a)*.26,.012),(math.cos(a)*.13,math.sin(a)*.13,.055),(0,0,.24)],.03,wood)
 crowns=[(-.35,0,1.15,.36),(.33,.06,1.30,.37),(0,.25,1.52,.37),(-.2,-.22,1.52,.34),(.20,-.20,1.59,.36),(0,.02,1.78,.30)]
 palette=pinks if pink else leaves
 for k,(x,y,z,r) in enumerate(crowns):
  curve('Branch '+str(k),[(0,0,.55),(.03+x*.45,y*.4,.89),(x,y,z)],.041,wood)
  ball('Soft crown core',(x,y,z),(r,r*.91,r*.76),palette[k%len(palette)])
  for i in range(75):
   a=rng.random()*math.tau;u=rng.uniform(-.8,1);rr=math.sqrt(1-u*u);px=x+math.cos(a)*r*rr;py=y+math.sin(a)*r*.91*rr;pz=z+r*.77*u
   if pink:
    leaf('Petal spray',(px,py,pz),.15,.060,palette[rng.randrange(len(palette))],a,rng.uniform(-.7,.7))
   else:leaf('Orchard leaf',(px,py,pz),rng.uniform(.16,.24),rng.uniform(.045,.065),palette[rng.randrange(len(palette))],a,rng.uniform(-.7,.7))
 for i in range(15):
  a=rng.random()*math.tau;r=rng.uniform(.12,.24);leaf('Root clover',(math.cos(a)*r,math.sin(a)*r,.023),.13,.045,leaves[i%5],a)
  if i%5==0:flower(math.cos(a)*r,math.sin(a)*r,.08,ivory,.025)
 return save(name,s)
def flower_border():
 s=setup()
 for i in range(44):
  x=rng.uniform(-.80,.80);y=rng.uniform(-.23,.23);z=rng.uniform(.08,.19)
  curve('Flower stem',[(x,y,.015),(x+.015,y,z)],.008,leaves[0])
  for j in range(3):leaf('Border leaf',(x,y,z*.4),.21,.07,leaves[(i+j)%5],rng.random()*6,.25)
  if i%2==0:flower(x,y,z,ivory if i%3 else pinks[0],.046)
  elif i%3==0:flower(x,y,z+.04,violet,.034)
 return save('flower-border',s)
def turf():
 s=setup();s.camera.location=(0,0,5);s.camera.rotation_euler=(0,0,0);s.camera.data.ortho_scale=2;s.render.resolution_x=512;s.render.resolution_y=512
 # A repeating ground material cannot inherit positional area-light falloff.
 # Constant environment + directional sunlight provide identical illumination
 # at opposite edges while preserving coherent micro-shadows on real leaves.
 rng.seed(57203)
 for light in list(s.objects):
  if light.type=='LIGHT':bpy.data.objects.remove(light,do_unlink=True)
 s.world.use_nodes=True;s.world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.65,.72,.58,1);s.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.6
 bpy.ops.object.light_add(type='SUN',location=(-3,-4,7));sun=bpy.context.object;sun.rotation_euler=(.35,-.4,-.3);sun.data.energy=1.5;sun.data.angle=.35
 s.cycles.samples=96
 groundmat=mat('Quiet meadow velvet',(.32,.47,.15));clovermat=mat('Young meadow clover',(.35,.49,.17));box('Meadow tile',(0,0,-.03),(2.6,2.6,.06),groundmat,0)
 # Sparse botanical clusters wrap at boundaries for a seamless repeating tile.
 for i in range(45):
  x=rng.uniform(-1,1);y=rng.uniform(-1,1)
  for dx in [-2,0,2]:
   for dy in [-2,0,2]:
    if abs(x+dx)<1.10 and abs(y+dy)<1.10:
     for j in range(3):
      blade=leaf('Clover blade',(0,0,0),.16,.05,clovermat,j*math.tau/3)
      blade.scale=(.30,.30,.055);blade.location=(x+dx,y+dy,.001)
 s.render.filepath=str(root/'clover-turf.png');bpy.ops.wm.save_as_mainfile(filepath=str(root/'clover-turf.blend'));bpy.ops.render.render(write_still=True)
 return {'image':'clover-turf.png','source':'clover-turf.blend','frameSize':[512,512],'seamless':True}
manifest={'generator':'scripts/charmville/render_workshop.py','revision':1,'author':'Charmville original workshop','license':'Original project-owned models; no third-party art','blender':bpy.app.version_string,'projection':'orthographic 2:1','frameSize':[256,192],'anchor':[128,132.444],'assets':{}}
if args.only=='turf':
 manifest=json.loads((root/'manifest.json').read_text());manifest['assets']['turf']=turf()
else:
 manifest['assets']['cottage']=cottage();manifest['assets']['orchard']=tree('orchard-tree');manifest['assets']['blossom']=tree('blossom-tree',True)
 manifest['assets']['flowers']=flower_border();manifest['assets']['turf']=turf()
for asset in manifest['assets'].values():
 asset['sha256']={key:hashlib.sha256((root/asset[key]).read_bytes()).hexdigest() for key in ['image','image3x','source','model'] if key in asset}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
