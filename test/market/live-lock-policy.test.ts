import test from 'node:test';
import assert from 'node:assert/strict';
import {PULSE_Q,pulseOutcome,rejectLiveLock,type LiveLockState} from '../../lib/casino/live-lock-policy.js';
const intent={round:4n,pulse:2n,multiplierBps:20000n,nonce:0n,deadlineMs:5000};
const state:LiveLockState={round:4n,pulse:2n,verifiedMultiplierBps:20000n,nonce:0n,cutoffMs:5000,entropyNotBeforeMs:9000,finalityMarginMs:1000,canonicalIncludedAtMs:4000,canonicalFinalizedAtMs:6000,anchorVerified:true,locked:false,crashed:false};
test('live-lock policy rejects stale, copied, retroactive and unverified-price intents',()=>{
 assert.equal(rejectLiveLock(intent,state),null);
 for(const change of [{round:5n},{pulse:3n},{nonce:1n},{multiplierBps:20001n},{deadlineMs:4000},{deadlineMs:5001}])assert.notEqual(rejectLiveLock({...intent,...change},state),null);
 for(const change of [{anchorVerified:false},{locked:true},{crashed:true},{canonicalFinalizedAtMs:8000},{canonicalFinalizedAtMs:3999},{canonicalIncludedAtMs:5000},{entropyNotBeforeMs:NaN}])assert.notEqual(rejectLiveLock(intent,{...state,...change}),null);
});
test('pulse tail preserves inverse-uniform survival at intermediate auto targets',()=>{
 for(const previous of [10000n,20000n,100000n])for(const next of [previous+1n,previous*2n,previous*10n]){
  const threshold=previous*PULSE_Q/next;
  assert.equal(pulseOutcome(previous,next,threshold).survived,true);
  assert.equal(pulseOutcome(previous,next,threshold+1n).survived,false);
  assert.ok(pulseOutcome(previous,next,PULSE_Q-1n).crashBps>=previous);
  assert.equal(pulseOutcome(previous,next,0n).survived,true);
 }
 // 1 -> 2 -> 4: conditional survival probabilities telescope to 1/4.
 assert.equal((10000n*PULSE_Q/20000n)*(20000n*PULSE_Q/40000n)/PULSE_Q,PULSE_Q/4n);
});
