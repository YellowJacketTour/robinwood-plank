import test from 'node:test';
import assert from 'node:assert/strict';
import {settledReturn} from '../../public/arcade/settled-return.js';
test('actual return and ROI agree at tiny and enormous stakes, including dilution',()=>{
 for(const stake of [100n,10n**12n,10n**33n]){
  assert.deepEqual(settledReturn(stake,stake*2n),{net:stake,returnedX:'2.00',roiPercent:'+100.00%'});
  assert.deepEqual(settledReturn(stake,stake*3n/4n),{net:-stake/4n,returnedX:'0.75',roiPercent:'-25.00%'});
  assert.equal(settledReturn(stake,0n).roiPercent,'-100.00%');
  assert.equal(settledReturn(stake,stake).roiPercent,'0.00%');
 }
 assert.throws(()=>settledReturn(0n,1n));
 assert.throws(()=>settledReturn(1n,-1n));
});
