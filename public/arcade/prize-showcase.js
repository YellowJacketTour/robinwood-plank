import * as THREE from './vendor/three/three.module.js';
import {prizeMagnitude,prizePieces} from './prize-magnitude.js';
// A small, separate viewport. Fixed 24-body ceiling; asleep when not interacting.
export function createPrizeShowcase(canvas){
 const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.25));renderer.setSize(144,108,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,4/3,.1,20);camera.position.set(2,2.5,3.8);camera.lookAt(0,.22,0);
 scene.add(new THREE.HemisphereLight(0xfff3d8,0x233d37,2));
 for(const [color,intensity,x,y,z] of [[0xffe4af,3,-3,5,3],[0xc4e8ff,2,3,2,-2]]){const light=new THREE.DirectionalLight(color,intensity);light.position.set(x,y,z);scene.add(light);}
 const studio=new THREE.Scene();studio.background=new THREE.Color(0x66685c);
 for(const x of [-3,3]){const card=new THREE.Mesh(new THREE.PlaneGeometry(3,5),new THREE.MeshBasicMaterial({color:0xffffff}));card.position.set(x,2,2);card.lookAt(0,0,0);studio.add(card);}
 const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(studio,.15);scene.environment=env.texture;
 const gold=new THREE.MeshStandardMaterial({color:0xe9b94e,metalness:.85,roughness:.22});
 const paper=document.createElement('canvas');paper.width=384;paper.height=256;const c=paper.getContext('2d');
 for(let face=0;face<6;face++){const x=(face%3)*128,y=Math.floor(face/3)*128;c.fillStyle=face===2||face===3?'#42694e':'#e4dec3';c.fillRect(x,y,128,128);
  if(face===2||face===3){c.strokeStyle='#c1bd83';c.lineWidth=2;c.strokeRect(x+5,y+6,118,116);c.strokeRect(x+10,y+11,108,106);for(let r=12;r<38;r+=3){c.beginPath();c.ellipse(x+64,y+64,r,r*.7,0,0,Math.PI*2);c.stroke();}for(let i=0;i<9;i++){c.beginPath();c.moveTo(x+14,y+18+i*11);c.bezierCurveTo(x+44,y+6+i*11,x+86,y+30+i*11,x+114,y+18+i*11);c.stroke();}}
  else {c.strokeStyle='#9b997e';c.lineWidth=.7;for(let row=3;row<128;row+=4){c.beginPath();c.moveTo(x,y+row);c.lineTo(x+128,y+row);c.stroke();}}
  c.fillStyle='#e9c969';c.fillRect(x+56,y,16,128);c.fillStyle='#f6e8ae';c.fillRect(x+58,y,2,128);
 }
 const texture=new THREE.CanvasTexture(paper);texture.colorSpace=THREE.SRGBColorSpace;
 const cashMaterial=new THREE.MeshStandardMaterial({map:texture,roughness:.7});
 function cashGeometry(height){const g=new THREE.BoxGeometry(.44,height,.23),uv=g.attributes.uv;for(let f=0;f<6;f++)for(let j=0;j<4;j++){const i=f*4+j;uv.setXY(i,((f%3)+uv.getX(i))/3,(Math.floor(f/3)+uv.getY(i))/2);}return g;}
 const gemMaterial=new THREE.MeshPhysicalMaterial({color:0xffffff,metalness:.25,roughness:.075,clearcoat:1,flatShading:true});
 const geometries={coin:new THREE.CylinderGeometry(.14,.14,.054,32),note:cashGeometry(.024),cash:cashGeometry(.13),bar:new THREE.BoxGeometry(.44,.13,.23),gem:new THREE.LatheGeometry([new THREE.Vector2(0,-.20),new THREE.Vector2(.17,-.02),new THREE.Vector2(.16,.09),new THREE.Vector2(.09,.14),new THREE.Vector2(0,.14)],8)};
 const meshes={},materials={coin:gold,note:cashMaterial,cash:cashMaterial,bar:gold,gem:gemMaterial};
 for(const kind of Object.keys(geometries)){const mesh=new THREE.InstancedMesh(geometries[kind],materials[kind],24);mesh.count=0;mesh.userData.indices=[];meshes[kind]=mesh;scene.add(mesh);}
 const tray=new THREE.Mesh(new THREE.BoxGeometry(2.4,.10,1.6),new THREE.MeshStandardMaterial({color:0x133c2c,roughness:.35,metalness:.35}));tray.position.y=-.08;scene.add(tray);
 for(const [x,z,w,d]of [[-1.18,0,.07,1.6],[1.18,0,.07,1.6],[0,-.78,2.4,.07],[0,.78,2.4,.07]]){const rim=new THREE.Mesh(new THREE.BoxGeometry(w,.20,d),gold);rim.position.set(x,.05,z);scene.add(rim);}
 const sparkle=new THREE.PointLight(0xffd97f,0,5,2);sparkle.position.set(0,1,1);scene.add(sparkle);
 const worker=new Worker(new URL('./prize-physics-worker.js',import.meta.url),{type:'module'});
 let generation=0,pieces=[],poses=null,ready=false,visible=false,busy=false,raf=null,last=0,activeUntil=0,impulse=null,disposed=false;
 const pose=new THREE.Object3D(),ray=new THREE.Raycaster(),pointer=new THREE.Vector2();let selected=-1,lastX=0;
 function wake(){if(!disposed&&visible&&!document.hidden&&raf===null)raf=requestAnimationFrame(frame);}
 function frame(now){raf=null;if(disposed||!visible||document.hidden||!ready)return;
  const dt=Math.min(.05,last?(now-last)/1000:1/60);last=now;
  if(poses){for(const [kind,mesh]of Object.entries(meshes)){mesh.userData.indices.forEach((id,i)=>{pose.position.fromArray(poses,id*7);pose.quaternion.fromArray(poses,id*7+3);pose.scale.setScalar(pieces[id].scale);pose.updateMatrix();mesh.setMatrixAt(i,pose.matrix);});mesh.instanceMatrix.needsUpdate=true;}}
  const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);if(canvas.dataset.width!==String(width)||canvas.dataset.height!==String(height)){renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();canvas.dataset.width=String(width);canvas.dataset.height=String(height);}
  sparkle.intensity=Math.max(0,(activeUntil-now)/1800)*1.2;renderer.render(scene,camera);
  canvas.dataset.drawCalls=String(renderer.info.render.calls);canvas.dataset.bodies=String(pieces.length);canvas.dataset.frames=String(Number(canvas.dataset.frames||0)+1);canvas.dataset.state=now<activeUntil?'interactive':'asleep';
  if(now<activeUntil){if(!busy){busy=true;worker.postMessage({dt,impulse,generation});impulse=null;}wake();}
 }
 worker.onmessage=({data})=>{if(disposed)return;if(data.error){canvas.hidden=true;ready=false;return;}if(data.generation!==generation)return;busy=false;poses=data.poses;ready=true;canvas.dataset.ready='true';if(visible)wake();};
 worker.onerror=()=>{ready=false;canvas.hidden=true;};
 function nudge(index,x=.012,z=.008){if(!ready||index<0)return;impulse={index,x,z};activeUntil=performance.now()+1800;wake();}
 const down=e=>{if(!ready)return;const rect=canvas.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(Object.values(meshes))[0];selected=hit?hit.object.userData.indices[hit.instanceId]:0;lastX=e.clientX;canvas.setPointerCapture(e.pointerId);nudge(selected);};
 const move=e=>{if(selected<0)return;nudge(selected,(e.clientX-lastX)*.001,.004);lastX=e.clientX;};
 const up=()=>selected=-1;const key=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();nudge(0);}};
 canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('keydown',key);
 const visibility=()=>{last=0;if(document.hidden){cancelAnimationFrame(raf);raf=null;}else wake();};document.addEventListener('visibilitychange',visibility);
 return {snapshot(){return Array.from(poses||[]);},prepare(value){const tier=prizeMagnitude(value);generation++;ready=false;delete canvas.dataset.ready;pieces=prizePieces(tier);canvas.hidden=tier===null;canvas.dataset.tier=String(tier);
   for(const [kind,mesh]of Object.entries(meshes)){mesh.userData.indices=pieces.flatMap((p,i)=>p.kind===kind?[i]:[]);mesh.count=mesh.userData.indices.length;if(kind==='gem'){mesh.userData.indices.forEach((_,i)=>mesh.setColorAt(i,new THREE.Color([0xc9efff,0x24c796,0xce4b72][i%3])));if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}}
   if(tier!==null){worker.postMessage({pieces,generation,gemVertices:Array.from(geometries.gem.attributes.position.array)});renderer.compileAsync(scene,camera).catch(()=>{});}
  },show(){visible=true;last=0;activeUntil=performance.now()+900;wake();},hide(){visible=false;cancelAnimationFrame(raf);raf=null;selected=-1;},dispose(){disposed=true;cancelAnimationFrame(raf);worker.terminate();document.removeEventListener('visibilitychange',visibility);for(const [name,fn]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up],['keydown',key]])canvas.removeEventListener(name,fn);const gs=new Set(),ms=new Set();for(const root of [scene,studio])root.traverse(o=>{if(o.geometry)gs.add(o.geometry);if(o.material)ms.add(o.material)});gs.forEach(g=>g.dispose());ms.forEach(m=>m.dispose());texture.dispose();env.dispose();pmrem.dispose();renderer.dispose();renderer.forceContextLoss();}};
}
