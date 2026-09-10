// Rigid-body chamber only. Contract entropy chooses the result before playback.
import RAPIER from './vendor/rapier/rapier.es.js';
import {dispensePosition} from './lottery-trajectory.js';
let initialization;
export async function createLotteryWorld({colliders,positions,radius}) {
  await (initialization??=RAPIER.init());
  const world=new RAPIER.World({x:0,y:-9.81,z:0});world.timestep=1/240;world.integrationParameters.numSolverIterations=16;world.integrationParameters.maxCcdSubsteps=4;world.integrationParameters.allowedLinearError=.0005;
  let bowlBody=null;
  for(const {vertices,indices,driven} of colliders){
    const body=driven?world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()):undefined;
    if(body)bowlBody=body;
    if(driven){
      // Solid convex tiles under the exact rendered bowl surface. A thin
      // moving triangle mesh can miss contacts along its internal edges.
      for(let i=0;i<indices.length;i+=6){
        const ids=[...new Set(Array.from(indices.slice(i,i+6)))];if(ids.length!==4)continue;
        const points=ids.map(id=>Array.from(vertices.slice(id*3,id*3+3)));
        const a=points[0],b=points[1],c=points[2],u=b.map((v,j)=>v-a[j]),v=c.map((n,j)=>n-a[j]);
        let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        const length=Math.hypot(...n);if(length<1e-10)continue;n=n.map(x=>x/length);
        const center=points.reduce((sum,p)=>sum.map((x,j)=>x+p[j]/4),[0,0,0]);
        if(n[0]*center[0]+n[2]*center[2]<0)n=n.map(x=>-x);
        const hull=RAPIER.ColliderDesc.convexHull(new Float32Array([...points,...points.map(p=>p.map((x,j)=>x+n[j]*.05))].flat()));
        if(hull)world.createCollider(hull.setFriction(.65).setRestitution(.25),body);
      }
    }else world.createCollider(RAPIER.ColliderDesc.trimesh(vertices,indices).setFriction(.65).setRestitution(.25),body);
  }
  // A small collision skin absorbs solver tolerance before visible surfaces
  // intersect each other or the triangulated glass/funnel boundary.
  const bodies=positions.map((p,i)=>{const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...p).setCcdEnabled(true).setLinearDamping(.12).setAngularDamping(.22));world.createCollider(RAPIER.ColliderDesc.ball(radius+.008).setDensity(1).setFriction(.55).setRestitution(.36),body);body.setAngvel({x:.7*(i%3),y:.3,z:.5},true);return body;});
  const selectedBody=world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...dispensePosition(0,radius)));
  world.createCollider(RAPIER.ColliderDesc.ball(radius),selectedBody);
  const gateBody=world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0,-.04,0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(.42,.025,.42),gateBody);
  // Prepare a resting chamber off-screen. The visible draw starts from this
  // settled packing, never from the construction lattice falling into the jar.
  for(let step=0;step<600;step++)world.step();
  bodies.forEach(body=>{body.setLinvel({x:0,y:0,z:0},false);body.setAngvel({x:0,y:0,z:0},false);body.sleep();});
  let accumulator=0,simulationTime=0;
  return {world,step(dt){
    accumulator+=Math.min(.1,dt);
    while(accumulator+1e-10>=world.timestep){
      const step=world.timestep;simulationTime+=step;accumulator=Math.max(0,accumulator-step);
      // Motor-driven bowl: only contact/friction transfers motion to balls.
      // Smooth acceleration and deceleration avoid a teleporting collider.
      const duration=3.6,t=Math.min(simulationTime,duration);
      const angle=.75*(t-duration/(2*Math.PI)*Math.sin(2*Math.PI*t/duration));
      if(bowlBody)bowlBody.setNextKinematicRotation({x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)});
      // Upper shutter stays shut while the isolated lower pocket dispenses.
      gateBody.setNextKinematicTranslation({x:0,y:-.04,z:0});
      const next=dispensePosition(simulationTime,radius);
      selectedBody.setNextKinematicTranslation({x:next[0],y:next[1],z:next[2]});world.step();
    }
  },packet(){
    const data=new Float32Array(bodies.length*10+4);
    bodies.forEach((b,i)=>{const p=b.translation(),q=b.rotation(),v=b.linvel();data.set([p.x,p.y,p.z,q.x,q.y,q.z,q.w,v.x,v.y,v.z],i*10);});
    const q=bowlBody?.rotation()||{x:0,y:0,z:0,w:1};data.set([q.x,q.y,q.z,q.w],bodies.length*10);return data;
  },snapshot(){return bodies.map(body=>({position:body.translation(),velocity:body.linvel()}));},dispose(){world.free();}};
}
