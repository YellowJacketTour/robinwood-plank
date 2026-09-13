import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advanceBeam,beamOrigin,clipBeam,startBeam,type BeamDirection} from '../../lib/charmville/beam-domain';

test('beam cadence is identical under tick batching, replay and recovery',()=>{
  const initial=startBeam(100,{chargeTicks:3,fireTicks:7,recoveryTicks:2,contactEveryTicks:2});
  let state=initial;const observed:number[]=[];
  for(let tick=101;tick<=112;tick++){const next=advanceBeam(state,tick);state=next.state;observed.push(...next.contacts);}
  const batched=advanceBeam(initial,112);
  assert.deepEqual(observed,[0,1,2,3]);assert.deepEqual(batched.contacts,observed);
  assert.equal(batched.phase,'complete');assert.deepEqual(advanceBeam(batched.state,112).contacts,[]);
  assert.equal(advanceBeam(initial,102).phase,'charge');assert.equal(advanceBeam(initial,103).phase,'fire');assert.equal(advanceBeam(initial,110).phase,'recovery');
  assert.throws(()=>advanceBeam(state,111));
});
test('interruption ends future contacts without deleting earlier authoritative ticks',()=>{
  const state=startBeam(0,{chargeTicks:3,fireTicks:7,recoveryTicks:2,contactEveryTicks:2});
  const interrupted=advanceBeam(state,5,true);
  assert.deepEqual(interrupted.contacts,[0]);assert.equal(interrupted.phase,'cancelled');
  assert.deepEqual(advanceBeam(interrupted.state,100).contacts,[]);
  assert.deepEqual(advanceBeam(state,2,true).contacts,[]);
});
test('authored sockets keep ground collision independent of elevation in every direction',()=>{
  const sockets={0:{x:0,y:-1},1:{x:0,y:1},2:{x:-1,y:0},3:{x:1,y:0}};
  for(const direction of [0,1,2,3] as BeamDirection[]){
    const a=beamOrigin({x:5,y:5},direction,sockets),b=beamOrigin({x:5,y:5},direction,sockets,2);
    assert.deepEqual(a.collision,b.collision);assert.equal(b.visual.y,a.visual.y-2);
  }
});
test('all cardinal beams terminate at wall faces and never return',()=>{
  const g={width:10,height:10,blocked:new Set(['5,2','5,8','2,5','8,5'])};
  const expected=[{x:5.5,y:3},{x:5.5,y:8},{x:3,y:5.5},{x:8,y:5.5}];
  for(const direction of [0,1,2,3] as BeamDirection[])assert.deepEqual(clipBeam({x:5.5,y:5.5},direction,20,0.5,g).end,expected[direction]);
});
test('beam envelope clips grazing walls; walls behind the socket do not block forward fire',()=>{
  const g={width:10,height:10,blocked:new Set(['6,4','4,5'])};
  assert.equal(clipBeam({x:5,y:5.5},3,4,0.5,g).length,4);
  assert.equal(clipBeam({x:5,y:5.5},3,4,2,g).length,1);
  assert.equal(clipBeam({x:5,y:5.5},3,40,0.5,g).end.x,10);
  assert.throws(()=>clipBeam({x:5,y:5},3,Infinity,1,g));
});
