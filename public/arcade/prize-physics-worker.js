import RAPIER from './vendor/rapier/rapier.es.js';
let world,bodies=[],ready=RAPIER.init();
function poses(){const out=new Float32Array(bodies.length*7);bodies.forEach((b,i)=>{const p=b.translation(),q=b.rotation();out.set([p.x,p.y,p.z,q.x,q.y,q.z,q.w],i*7)});return out;}
self.onmessage=async({data})=>{try{
 await ready;
 if(data.pieces){world?.free();world=new RAPIER.World({x:0,y:-9.81,z:0});world.timestep=1/120;world.integrationParameters.numSolverIterations=8;
  world.createCollider(RAPIER.ColliderDesc.cuboid(1.2,.06,.8).setTranslation(0,-.06,0));
  for(const [x,z,hx,hz] of [[-1.18,0,.035,.8],[1.18,0,.035,.8],[0,-.78,1.2,.035],[0,.78,1.2,.035]])world.createCollider(RAPIER.ColliderDesc.cuboid(hx,.10,hz).setTranslation(x,.10,z));
  bodies=data.pieces.slice(0,24).map(p=>{const b=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x,p.y,p.z).setRotation({x:0,y:Math.sin(p.angle/2),z:0,w:Math.cos(p.angle/2)}).setLinearDamping(1.4).setAngularDamping(2.1).setCcdEnabled(true));
   let shape;
   if(p.kind==='coin')shape=RAPIER.ColliderDesc.cylinder(.027,.14);
   else if(p.kind==='gem'){const s=p.scale;shape=RAPIER.ColliderDesc.convexHull(Float32Array.from(data.gemVertices,v=>v*s));}
   else shape=RAPIER.ColliderDesc.cuboid(.22,p.kind==='note'?.012:.065,.115);
   world.createCollider(shape.setMass(.25).setFriction(.72).setRestitution(.12),b);return b;});
  for(let i=0;i<300;i++)world.step();bodies.forEach(b=>b.sleep());
 }else if(world){
  if(data.impulse){const {index,x,z}=data.impulse;const b=bodies[index];if(b){b.applyImpulse({x:Math.max(-.025,Math.min(.025,x)),y:.12,z:Math.max(-.025,Math.min(.025,z))},true);b.applyTorqueImpulse({x:.002,z:.003,y:0},true);}}
  const steps=Math.min(8,Math.max(1,Math.ceil((data.dt||0)*120)));for(let i=0;i<steps;i++)world.step();
 }
 if(world){const packet=poses();self.postMessage({poses:packet,sleeping:bodies.every(b=>b.isSleeping()),generation:data.generation},[packet.buffer]);}
}catch(e){self.postMessage({error:String(e.message||e)});}};
