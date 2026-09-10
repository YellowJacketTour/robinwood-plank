import test from 'node:test';
import assert from 'node:assert/strict';
import {tick} from '../../scripts/casino-keeper.js';
test('accelerated and mock keeper modes fail before touching any public-chain contract',async()=>{
 for(const chainId of [4663n,46630n,1n])for(const flags of [{mockBeacon:true},{mockImmediateAfterClose:true},{mockMinCrashBps:20000n}]){
  const provider={getNetwork:async()=>({chainId})};
  await assert.rejects(tick(provider as any,{} as any,{crash:'',lottery:'',beacon:'',router:'',...flags}),/local chain 31337/);
 }
});
