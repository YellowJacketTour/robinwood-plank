import * as THREE from './vendor/three/three.module.js';
import {batchStaticMeshes} from './static-mesh-batch.js';
import {createChamberBalls} from './lottery-ball-atlas.js';
import {createLotteryFunnelGeometry} from './lottery-funnel.js';
import {lotteryPopulation} from './lottery-population.js';
import {renderRatio} from './render-budget.js';

// Playback only. The selected ball, path, and housing share these dimensions.
// Its radius is constant; the final inspection is a camera move, never a scale trick.
import {BALL_RADIUS,dispensePosition} from './lottery-trajectory.js';
export {BALL_RADIUS,dispensePosition} from './lottery-trajectory.js';
export function mountLotteryMachine(canvas,{result=null,onReady=()=>{},paused=false,startAt=null,onPrepared=()=>{}}={}){
  const population=lotteryPopulation(result?.ballCount??16,result?.drawnBall??1);
  const radius=population.radius,path=t=>dispensePosition(t,radius);
  const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(36,1,.1,30);
  const machine=new THREE.Group();scene.add(machine);
  const ivory=new THREE.MeshPhysicalMaterial({color:0xe3dfca,roughness:.32,metalness:.25,clearcoat:.25});
  const enamel=new THREE.MeshPhysicalMaterial({color:0x204e42,roughness:.28,metalness:.35,clearcoat:.4});
  const brass=new THREE.MeshStandardMaterial({color:0xc89e52,roughness:.3,metalness:.8});
  const steel=new THREE.MeshStandardMaterial({color:0x7a8586,roughness:.4,metalness:.7});
  const dark=new THREE.MeshStandardMaterial({color:0x111b19,roughness:.7});
  const textures=[];
  function add(geometry,material,x=0,y=0,z=0,parent=machine){const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
  function box(w,h,d,mat,x,y,z,parent){const bevel=Math.min(.015,w/5,h/5,d/5);const g=new THREE.ExtrudeGeometry(rounded(w-bevel*2,h-bevel*2,Math.min(.04,w/4,h/4)),{depth:d-bevel*2,bevelEnabled:true,bevelSize:bevel,bevelThickness:bevel,bevelSegments:3,curveSegments:6});g.translate(0,0,-d/2+bevel);return add(g,mat,x,y,z,parent);}
  function rounded(w,h,r){const s=new THREE.Shape();s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);s.lineTo(w/2,h/2-r);s.quadraticCurveTo(w/2,h/2,w/2-r,h/2);s.lineTo(-w/2+r,h/2);s.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);s.lineTo(-w/2,-h/2+r);s.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);return s;}
  function plate(w,h,d,mat,x,y,z){return add(new THREE.ExtrudeGeometry(rounded(w,h,.09),{depth:d,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.035,bevelThickness:.035,curveSegments:12}),mat,x,y,z);}
  // The front is a real cut-out panel, not an opaque body with a dark decal.
  const front=rounded(2.05,1.42,.23),hole=new THREE.Path();
  hole.moveTo(-.34,-.46);hole.lineTo(-.34,.20);hole.lineTo(.34,.20);hole.lineTo(.34,-.46);hole.closePath();front.holes.push(hole);
  add(new THREE.ExtrudeGeometry(front,{depth:.09,bevelEnabled:true,bevelSize:.035,bevelThickness:.035,bevelSegments:5,curveSegments:16}),enamel,0,-1.07,.7);
  box(.10,1.28,1.40,enamel,-1,-1.07,0);box(.10,1.28,1.40,enamel,1,-1.07,0);box(2,1.28,.1,enamel,0,-1.07,-.7);
  // A raised metal surround follows the actual open outlet, never obscuring it.
  const collar=rounded(.87,.83,.13);collar.holes.push(rounded(.72,.68,.025));
  add(new THREE.ExtrudeGeometry(collar,{depth:.035,bevelEnabled:true,bevelSize:.012,bevelThickness:.012,bevelSegments:3}),brass,0,-1.20,.80);
  // Inlaid ivory shoulder and a machined medallion give the housing a deliberate face.
  box(1.44,.085,.035,ivory,0,-.55,.818);
  const medallion=add(new THREE.CylinderGeometry(.11,.11,.035,48),brass,-.68,-.99,.835);medallion.rotation.x=Math.PI/2;
  const star=new THREE.Shape();for(let i=0;i<10;i++){const angle=Math.PI/2+i*Math.PI/5,r=i%2?.034:.075;const x=Math.cos(angle)*r,y=Math.sin(angle)*r;i?star.lineTo(x,y):star.moveTo(x,y);}star.closePath();add(new THREE.ShapeGeometry(star),ivory,-.68,-.99,.857);
  plate(2.2,.17,1.55,brass,0,-1.84,-.77);
  const roof=rounded(2,1.4,.08),throat=new THREE.Path();throat.absarc(0,0,.23,0,Math.PI*2,true);roof.holes.push(throat);
  const roofMesh=add(new THREE.ExtrudeGeometry(roof,{depth:.07,bevelEnabled:false}),enamel,0,-.37,0);roofMesh.rotation.x=-Math.PI/2;
  // Open annular top and funnel leave a .42-wide throat for the .32 ball.
  const bowlMetal=steel.clone();bowlMetal.side=THREE.DoubleSide;
  const funnel=add(createLotteryFunnelGeometry(THREE),bowlMetal);
  const topRing=add(new THREE.TorusGeometry(.94,.055,12,80),brass,0,.32);topRing.rotation.x=Math.PI/2;
  // Internal guide rails have clearance all the way from throat to outlet.
  box(.06,.55,1.62,steel,-.25,-1.24,.36);box(.06,.55,1.62,steel,.25,-1.24,.36);
  const ramp=box(.47,.06,1.73,steel,0,-1.46,.57);ramp.rotation.x=.115;
  // Recessed receiving tray, continuous with the ramp, with a real end stop.
  plate(.80,.09,1.0,enamel,0,-1.60,.79);
  box(.70,.024,.86,dark,0,-1.53,1.30);
  box(.06,.21,1.02,brass,-.40,-1.49,1.28);box(.06,.21,1.02,brass,.40,-1.49,1.28);box(.83,.18,.06,brass,0,-1.50,1.80);
  // Side-mounted crank cannot occupy the central ball outlet.
  const crank=new THREE.Group();crank.position.set(.72,-.72,.88);machine.add(crank);
  const hub=add(new THREE.CylinderGeometry(.18,.18,.12,40),brass,0,0,0,crank);hub.rotation.x=Math.PI/2;
  const arm=box(.085,.36,.09,steel,0,-.14,.07,crank);
  const handle=add(new THREE.CylinderGeometry(.07,.07,.2,24),dark,0,-.30,.15,crank);handle.rotation.x=Math.PI/2;
  for(const x of [-.86,.86])for(const y of [-1.60,-.48]){const screw=add(new THREE.CylinderGeometry(.043,.043,.022,6),steel,x,y,.824);screw.rotation.x=Math.PI/2;}
  // Clear mineral glass dome: transparent walls only, never a transparent chassis.
  const glass=new THREE.MeshPhysicalMaterial({color:0xffffff,roughness:.04,metalness:0,transmission:0,thickness:.025,ior:1.47,transparent:true,opacity:.12,depthWrite:false});
  const globe=add(new THREE.SphereGeometry(1.12,64,40,0,Math.PI*2,0,2.10),glass,0,.89);globe.castShadow=false;globe.renderOrder=3;
  // One-ball metering pocket: the upper shutter retains the chamber while
  // the lower shutter releases the already recorded ball. No second ball follows.
  const gate=box(.84,.05,.84,steel,0,-.04,0);
  const releaseGate=box(.48,.04,.48,steel,0,-.46,0);
  const cap=add(new THREE.CylinderGeometry(.32,.42,.10,64),brass,0,1.99);
  add(new THREE.SphereGeometry(.10,24,16),brass,0,2.10);
  // Actual studio cards provide broad surface reflections on metal and glass.
  const studio=new THREE.Scene();studio.background=new THREE.Color(0x36434b);
  for(const [x,y,z,w,h] of [[-3,3,2,2,5],[3,1,1,1,4],[0,4,-2,4,2]]){const card=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:0xffffff}));card.position.set(x,y,z);card.lookAt(0,0,0);studio.add(card);}
  const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(studio,.12);scene.environment=env.texture;
  scene.add(new THREE.HemisphereLight(0xfff5df,0x27332f,1.6));
  const key=new THREE.DirectionalLight(0xffead1,3.0);key.position.set(-3,5,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.camera.left=-4;key.shadow.camera.right=4;key.shadow.camera.top=4;key.shadow.camera.bottom=-4;key.shadow.bias=-.001;scene.add(key);
  const fill=new THREE.DirectionalLight(0xa7d6ff,1.2);fill.position.set(4,2,0);scene.add(fill);
  const floor=add(new THREE.CircleGeometry(4,80),new THREE.ShadowMaterial({opacity:.22}),0,-1.98,0);floor.rotation.x=-Math.PI/2;floor.castShadow=false;
  const colors=[0xe88a96,0xa898db,0x79bdae,0x83a8cf,0xb8a0c8];
  function ball(text,color){
    const group=new THREE.Group();machine.add(group);
    // A single continuous spherical surface: no floating label geometry.
    const surface=document.createElement('canvas');surface.width=512;surface.height=256;const c=surface.getContext('2d');
    c.fillStyle=`#${color.toString(16).padStart(6,'0')}`;c.fillRect(0,0,512,256);
    c.fillStyle='#f4efdf';c.beginPath();c.ellipse(128,128,53,48,0,0,Math.PI*2);c.fill();
    c.strokeStyle='#263c3530';c.lineWidth=2;c.stroke();
    c.fillStyle='#23372f';let fontSize=46;c.font=`600 ${fontSize}px Arial`;
    while(c.measureText(text).width>92&&fontSize>8){fontSize--;c.font=`600 ${fontSize}px Arial`;}
    c.textAlign='center';c.textBaseline='middle';c.fillText(text,128,129,92);
    const texture=new THREE.CanvasTexture(surface);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=renderer.capabilities.getMaxAnisotropy();textures.push(texture);
    const sphere=add(new THREE.SphereGeometry(radius,48,32),new THREE.MeshPhysicalMaterial({map:texture,roughness:.30,clearcoat:.32,clearcoatRoughness:.24}),0,0,0,group);
    return {group,sphere};
  }
  const {count,visible:visibleCount,labels}=population,selectedNumber=BigInt(result?.drawnBall??1);
  const homes=population.homes.map(p=>new THREE.Vector3(...p));
  const chamber=createChamberBalls(THREE,machine,labels,n=>n===1n?0xe7b348:colors[Number(n%5n)],radius);textures.push(chamber.texture);
  const balls=chamber.balls;balls.forEach((b,i)=>{b.home=homes[i];b.group.position.copy(b.home);});chamber.sync();chamber.mesh.visible=false;
  const selected=ball(result?.drawLabel??selectedNumber.toString(),selectedNumber===1n?0xe7b348:colors[Number(selectedNumber%5n)]);selected.group.position.set(...path(0));selected.group.visible=count>0n;
  canvas.dataset.batchedMeshes=String(batchStaticMeshes(THREE,machine,new Set([globe,funnel,topRing,roofMesh,cap,gate,releaseGate,chamber.mesh])));
  canvas.dataset.ballTextures='2';canvas.dataset.chamberDrawCalls=labels.length?'1':'0';
  canvas.dataset.sampled=String(population.sampled);canvas.dataset.population=count.toString();canvas.dataset.visiblePopulation=String(visibleCount);
  let playing=!paused,prepared=false;
  let elapsed=0,previous=performance.now(),startedAt=Number.isFinite(startAt)?startAt:null,raf=null,reducedTimer=null,stopped=false,notified=false;
  let physics=null;const physicsAbort=new AbortController();
  import("./lottery-machine-physics.js").then(({createLotteryPhysics})=>createLotteryPhysics({meshes:[globe,funnel,topRing,roofMesh,cap],drivenSurface:funnel,balls,selected,radius,gate,path,signal:physicsAbort.signal,onError:()=>canvas.dispatchEvent(new Event("lottery-render-error"))})).then(value=>{if(stopped)value.dispose();else{physics=value;physics.step(0);chamber.sync();chamber.mesh.visible=true;canvas.dataset.physics='rapier';canvas.dataset.physicsThread=value.worker?'worker':'main';wake();}}).catch(error=>{if(stopped)return;canvas.dataset.physics='unavailable';canvas.dispatchEvent(new Event("lottery-render-error"));console.error('Lottery physics initialization failed',error);});
  const rollingAxis=new THREE.Vector3(1,0,0),orientationTarget=new THREE.Object3D();
  const rollStart=new THREE.Quaternion().setFromEuler(new THREE.Euler(.4,1.1,.2));
  const rollEnd=new THREE.Quaternion().setFromAxisAngle(rollingAxis,1.48/radius).multiply(rollStart);
  const debugPhysics=["localhost","127.0.0.1"].includes(location.hostname)&&new URLSearchParams(location.search).has('physicsDebug');
  const contactTriangles=[];
  if(debugPhysics){const g=funnel.geometry,a=g.attributes.position,idx=g.index;for(let i=0;i<idx.count;i+=3)contactTriangles.push(new THREE.Triangle(...[0,1,2].map(j=>new THREE.Vector3().fromBufferAttribute(a,idx.getX(i+j)))));}
  let lastContactCheck=-1;const contactPoint=new THREE.Vector3(),contactClosest=new THREE.Vector3(),contactInverse=new THREE.Quaternion();
  let drawingWidth=0,drawingHeight=0,drawingRatio=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function wake(){if(stopped||document.hidden||raf!==null)return;previous=performance.now();raf=requestAnimationFrame(frame);}
  const resizeObserver=new ResizeObserver(wake);resizeObserver.observe(canvas);
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=null;}else wake();};
  document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',wake);
  const contextLost=event=>{event.preventDefault();if(!stopped)canvas.dispatchEvent(new Event('lottery-render-error'));};
  canvas.addEventListener('webglcontextlost',contextLost);
  function frame(now){
    raf=null;if(stopped||document.hidden)return;previous=now;const previousElapsed=elapsed;
    if(physics&&playing){startedAt??=now;elapsed=Math.min(8,Math.max(0,(now-startedAt)/1000));}
    const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight),ratio=renderRatio(width,height,devicePixelRatio||1);
    // Compare CSS dimensions, not rounded device pixels: Three floors its buffer.
    if(width!==drawingWidth||height!==drawingHeight||ratio!==drawingRatio){drawingWidth=width;drawingHeight=height;drawingRatio=ratio;renderer.setPixelRatio(ratio);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();canvas.dataset.bufferResizes=String(Number(canvas.dataset.bufferResizes||0)+1);}
    const t=result&&playing?(reduced.matches?(elapsed>=4.8?5:0):elapsed):0;
    const inspect=reduced.matches?(t>=4.8?1:0):Math.max(0,Math.min(1,(t-3.6)/1.2));const ease=inspect*inspect*(3-2*inspect);
    const resting=path(5),inspectionDistance=radius*7;
    camera.position.set(2.5*(1-ease),1.25*(1-ease)+(resting[1]+radius*4.5)*ease,8*(1-ease)+(resting[2]+inspectionDistance)*ease);
    camera.lookAt(0,.10*(1-ease)+resting[1]*ease,.3*(1-ease)+resting[2]*ease);
    selected.group.position.set(...path(t));
    if(physics&&!reduced.matches&&elapsed>previousElapsed)physics.step(elapsed-previousElapsed);
    chamber.sync();
    // Roll without slipping along the ramp; only orient the printed number
    // once the ball has reached the tray. Chamber numbers rotate with bodies.
    selected.group.quaternion.setFromAxisAngle(rollingAxis,Math.max(0,selected.group.position.z)/radius).multiply(rollStart);
    if(t>=3.6){orientationTarget.position.copy(selected.group.position);orientationTarget.lookAt(camera.position);selected.group.quaternion.copy(rollEnd).slerp(orientationTarget.quaternion,reduced.matches?1:ease);}
    canvas.dataset.physicsBodies=String(balls.length);
    canvas.dataset.ballRotation=selected.group.quaternion.toArray().join(',');
    if(physics&&debugPhysics){
      canvas.dataset.chamberSnapshot=JSON.stringify(physics.snapshot());
      if(elapsed-lastContactCheck>.2){lastContactCheck=elapsed;contactInverse.copy(funnel.quaternion).invert();let penetration=0;
        for(const b of [...balls,selected]){contactPoint.copy(b.group.position).applyQuaternion(contactInverse);let distance=Infinity;
          for(const tri of contactTriangles){tri.closestPointToPoint(contactPoint,contactClosest);distance=Math.min(distance,contactClosest.distanceTo(contactPoint));}
          if(radius-distance>penetration){penetration=radius-distance;canvas.dataset.funnelContact=JSON.stringify({selected:b===selected,position:b.group.position.toArray(),elapsed,penetration});}
        }canvas.dataset.funnelPenetration=String(penetration);
      }
    }
    releaseGate.position.x=.55*Math.max(0,Math.min(1,(t-1.15)/.25));
    crank.rotation.z=-Math.PI*2*Math.min(1,t/1.4);

    canvas.dataset.phase=!physics?'loading':t<1.4?'mixing':t<2.3?'chute':t<3.6?'rolling':t<4.8?'orienting':'presented';
    canvas.dataset.ballPosition=selected.group.position.toArray().join(',');canvas.dataset.ballRadius=String(radius);
    canvas.dataset.elapsed=elapsed.toFixed(3);canvas.dataset.inspectionDistance=inspectionDistance.toFixed(3);
    if(t>=4.8&&!notified){notified=true;onReady();}
    if(!physics)return;
    renderer.render(scene,camera);if(!prepared){prepared=true;onPrepared();}canvas.dataset.drawCalls=String(renderer.info.render.calls);canvas.dataset.triangles=String(renderer.info.render.triangles);canvas.dataset.renderFrame=String(Number(canvas.dataset.renderFrame||0)+1);
    const animating=playing&&(!reduced.matches&&elapsed<8);canvas.dataset.renderState=animating?'animating':'idle';
    if(animating)raf=requestAnimationFrame(frame);
    else if(playing&&reduced.matches&&!notified){clearTimeout(reducedTimer);reducedTimer=setTimeout(wake,Math.max(1,4800-elapsed*1000));}
  }
  wake();
  const dispose=()=>{stopped=true;clearTimeout(reducedTimer);physicsAbort.abort();cancelAnimationFrame(raf);resizeObserver.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',wake);canvas.removeEventListener('webglcontextlost',contextLost);physics?.dispose();chamber.dispose();const geometries=new Set(),materials=new Set();for(const root of [scene,studio])root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());env.dispose();pmrem.dispose();renderer.dispose();renderer.forceContextLoss();};
  dispose.start=(at=null)=>{if(stopped)return;playing=true;startedAt=Number.isFinite(at)?at:null;wake();};
  return dispose;
}
