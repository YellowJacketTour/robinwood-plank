import test from 'node:test';
import assert from 'node:assert/strict';
import {standardBallThreshold,ordinaryBallThreshold,type StandardCaptureBall,type CaptureStatus} from '../../lib/charmville/capture-math';

test('standard ball bonus truncates before the HP factor, as Emerald does',()=>{
 assert.equal(standardBallThreshold(3,1,2,'great').odds,2);
 assert.equal(standardBallThreshold(255,10,10,'poke').odds,85);
 assert.equal(standardBallThreshold(255,10,10,'great').odds,127);
 assert.equal(standardBallThreshold(255,10,10,'ultra').odds,170);
 for(const ball of ['premier','luxury'] as const)assert.deepEqual(standardBallThreshold(255,10,10,ball),ordinaryBallThreshold(255,10,10));
 assert.deepEqual(standardBallThreshold(255,10,10,'safari'),standardBallThreshold(255,10,10,'great'));
});

test('major statuses apply after HP truncation without stacking',()=>{
 for(const status of ['sleep','freeze'] as const)assert.equal(standardBallThreshold(255,10,10,'poke',status).odds,170);
 for(const status of ['poison','toxic-poison','burn','paralysis'] as const)assert.equal(standardBallThreshold(255,10,10,'poke',status).odds,127);
 // Floor HP factor to 1, then floor 1.5 to 1; multiplying first would yield 2.
 assert.equal(standardBallThreshold(5,10,10,'poke','poison').odds,1);
 assert.equal(standardBallThreshold(255,1,10,'ultra','sleep').threshold,65536);
 assert.equal(standardBallThreshold(1,10,10,'poke','sleep').threshold,0);
});

test('unsupported or impossible modifiers fail closed at the math boundary',()=>{
 for(const ball of ['master','timer','__proto__','toString','unknown'])assert.throws(()=>standardBallThreshold(255,1,10,ball as StandardCaptureBall));
 for(const status of ['confusion','sleep,poison','unknown'])assert.throws(()=>standardBallThreshold(255,1,10,'poke',status as CaptureStatus));
 assert.throws(()=>standardBallThreshold(255,0,10,'ultra','sleep'));
 assert.throws(()=>standardBallThreshold(255,11,10,'ultra'));
});

test('existing ordinary capture remains identical across catch rates and HP boundaries',()=>{
 for(let rate=1;rate<=255;rate++)for(const hp of [1,49,50,99,100]){
  const odds=Math.floor(rate*(300-2*hp)/300);
  const threshold=odds>254?65536:odds===0?0:Math.floor(1048560/Math.floor(Math.sqrt(Math.floor(Math.sqrt(Math.floor(16711680/odds))))));
  assert.deepEqual(ordinaryBallThreshold(rate,hp,100),{odds,threshold});
 }
});
