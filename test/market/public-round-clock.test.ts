import test from 'node:test';
import assert from 'node:assert/strict';
import {publicFlightAt,publicFlightDuration,canCommitPublicRound,canRepeatPublicRound} from '../../public/arcade/public-round-clock.js';
import {lotteryDelay} from '../../public/arcade/presentation-timing.js';

test('repeat cannot commit through a previous presentation or rush a closing book',()=>{
 assert.equal(canRepeatPublicRound({storyActive:true,remainingMs:30000}),false);
 assert.equal(canRepeatPublicRound({storyActive:false,remainingMs:7999}),false);
 assert.equal(canRepeatPublicRound({storyActive:false,remainingMs:8000}),true);
 assert.equal(canRepeatPublicRound({storyActive:false,remainingMs:30000,reviewRemainingMs:1}),false);
 assert.equal(canRepeatPublicRound({storyActive:false,remainingMs:30000,reviewRemainingMs:0}),true);
 assert.equal(lotteryDelay(2600,2000),600);
 assert.equal(lotteryDelay(2600,3000),0);
 assert.equal(lotteryDelay(undefined,0,true),150);
});
test('every public replay follows the same curve, with exact ignition and crash endpoints',()=>{
 for(const end of [10000,10001,15000,20000,100000,100000000]){
  const duration=publicFlightDuration(end);
  assert.equal(publicFlightAt(0,end).multiplier,1);
  assert.equal(publicFlightAt(1399,end).complete,false);
  assert.equal(publicFlightAt(1400+duration,end).complete,true);
  assert.ok(Math.abs(publicFlightAt(1400+duration,end).multiplier-end/10000)<1e-8);
  for(let t=0;t<duration;t+=17)assert.ok(Math.abs(publicFlightAt(1400+t,end).multiplier-Math.exp(.22*t/1000))<1e-8);
 }
 assert.equal(publicFlightAt(3000,20000).multiplier,publicFlightAt(3000,1000000).multiplier);
});
test('bet controls close at deadline and fail closed on stale reads or pending submissions',()=>{
 const base={phase:0,deadlineMs:30000,nowMs:29999,freshAtMs:29000,pending:false};
 assert.equal(canCommitPublicRound(base),true);
 for(const override of [{nowMs:30000},{phase:1},{phase:2},{pending:true},{freshAtMs:20000},{deadlineMs:NaN}])assert.equal(canCommitPublicRound({...base,...override}),false);
});
test('inverse-uniform crash residues reach 2x half the time and retain the tail',()=>{
 const values=Array.from({length:10000},(_,r)=>Math.floor(100000000/(10000-r)));
 assert.equal(values.filter(x=>x>=20000).length,5000);
 assert.equal(values.filter(x=>x>=100000).length,1000);
 assert.equal(values.filter(x=>x>=1000000).length,100);
 assert.equal(Math.max(...values),100000000);
});
