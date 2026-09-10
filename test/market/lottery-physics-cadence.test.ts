import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../public/arcade/vendor/three/three.module.js';
import {createLotteryWorld} from '../../public/arcade/lottery-physics-world.js';
import {createLotteryFunnelGeometry} from '../../public/arcade/lottery-funnel.js';
import {dispensePosition} from '../../public/arcade/lottery-machine-3d.js';

test('chamber physics is unchanged by 60, 15 or 10 FPS rendering cadence',async()=>{
 async function run(fps:number,driven=true){
  const globe=new THREE.Mesh(new THREE.SphereGeometry(1.12,64,40,0,Math.PI*2,0,2.10));globe.position.y=.89;
  const funnel=new THREE.Mesh(createLotteryFunnelGeometry(THREE));
  const homes=[];
  for(let y=.35;y<1.8;y+=.34)for(let x=-.68;x<.70;x+=.34)for(let z=-.68;z<.70;z+=.34){const p=new THREE.Vector3(x,y,z);if(p.distanceTo(new THREE.Vector3(0,.89,0))<.94&&p.distanceTo(new THREE.Vector3(0,.22,0))>.34)homes.push(p);}
  const balls=homes.slice(0,63).map(position=>{const group=new THREE.Group();group.position.copy(position);return{group};});
  const selected={group:new THREE.Group()};selected.group.position.set(0,-.25,0);
  const gate=new THREE.Group();gate.position.y=-.04;
  const colliders=[globe,funnel].map(mesh=>{mesh.updateMatrixWorld(true);const g=mesh.geometry.clone();g.applyMatrix4(mesh.matrixWorld);const descriptor={vertices:new Float32Array(g.attributes.position.array),indices:new Uint32Array(g.index.array),driven:driven&&mesh===funnel};g.dispose();return descriptor;});
  const physics=await createLotteryWorld({colliders,positions:balls.map(b=>b.group.position.toArray()),radius:.16});
  try{for(let frame=0;frame<fps*3;frame++)physics.step(1/fps);return physics.snapshot();}
  finally{physics.dispose();globe.geometry.dispose();funnel.geometry.dispose();globe.material.dispose();funnel.material.dispose();}
 }
 const reference=await run(60);
 const stationary=await run(60,false);
 assert.ok(reference.some((body:any,index:number)=>Math.hypot(body.position.x-stationary[index].position.x,body.position.z-stationary[index].position.z)>.02),
  "The driven bowl must transfer motion through contact, beyond gravity-only settling");
 for(const fps of [15,10]){
  const result=await run(fps);assert.equal(result.length,reference.length);
  result.forEach((body:any,index:number)=>{for(const key of ['position','velocity'])for(const axis of ['x','y','z'])assert.ok(Math.abs(body[key][axis]-reference[index][key][axis])<1e-6,`${fps} FPS changed ${key}.${axis} of ball ${index}`);});
 }
});
