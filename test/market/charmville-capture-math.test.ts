import test from 'node:test';
import assert from 'node:assert/strict';
import {ordinaryBallThreshold,captureShakes} from '../../lib/charmville/capture-math';
test('ordinary capture retains source integer truncation and rejects fainted targets',()=>{
 // 16711680 / 85 = 196608; integer roots are 443 then 21.
 assert.deepEqual(ordinaryBallThreshold(255,10,10),{odds:85,threshold:49931});
 assert.equal(ordinaryBallThreshold(1,10,10).threshold,0);
 assert(ordinaryBallThreshold(255,1,10).threshold>ordinaryBallThreshold(255,10,10).threshold);
 assert.throws(()=>ordinaryBallThreshold(255,0,10));assert.throws(()=>ordinaryBallThreshold(256,1,10));
});
test('four strict comparisons resolve capture and all failure stages',()=>{
 for(let i=0;i<4;i++){const draws=[0,0,0,0];draws[i]=100;assert.deepEqual(captureShakes(100,draws),{captured:false,shakes:i});}
 assert.deepEqual(captureShakes(100,[99,99,99,99]),{captured:true,shakes:4});
 assert.throws(()=>captureShakes(100,[1,2,3]));
});
