import assert from "node:assert/strict";
import test from "node:test";
import { SharedViewCache } from "../../lib/market/multichain/shared-view";

const policy = {freshMs:1000,retainMs:60_000};

test("a thousand simultaneous readers share one build; warm reads do no backing work", async () => {
  const cache = new SharedViewCache();
  let calls = 0;
  const load = async () => { calls++; await new Promise(resolve=>setTimeout(resolve,10)); return {value:{volume:"58160000000000000000"},capturedAt:Date.now()}; };
  const cold = await Promise.all(Array.from({length:1000},()=>cache.read("same-collection",load,policy)));
  assert.equal(calls,1);
  assert.ok(cold.every(view=>view.value.volume==="58160000000000000000"));
  await Promise.all(Array.from({length:2000},()=>cache.read("same-collection",load,policy)));
  assert.equal(calls,1,"warm traffic must not acquire database leases or call providers");
});

test("a failed refresh preserves the last view and its original observation time", async () => {
  const cache = new SharedViewCache();
  const capturedAt = Date.now()-5000;
  await cache.read("collection",async()=>({value:{traits:42},capturedAt}),policy);
  const deferred:Array<()=>Promise<void>>=[];
  let attempts=0;
  const result=await cache.read("collection",async()=>{attempts++;throw new Error("database offline");},
    {...policy,freshMs:0,defer:work=>deferred.push(work)});
  assert.equal(result.value.traits,42);
  assert.equal(result.capturedAt,capturedAt);
  assert.equal(attempts,0,"the response does not wait for recovery");
  await Promise.all(deferred.map(work=>work()));
  assert.equal(attempts,1);
  const retained=await cache.read("collection",async()=>{throw new Error("must remain warm");},policy);
  assert.equal(retained.capturedAt,capturedAt,"failure must never make old data appear new");
});

test("missing evidence rejects, chain keys stay distinct, and cache size is bounded", async () => {
  const cache=new SharedViewCache(10000,2);
  await assert.rejects(cache.read("missing",async()=>{throw new Error("offline");},policy),/offline/);
  let calls=0;
  const load=async()=>({value:++calls,capturedAt:Date.now()});
  const first=await cache.read("solana:AbC",load,policy);
  const second=await cache.read("solana:abc",load,policy);
  assert.notEqual(first.value,second.value);
  await cache.read("ethereum:abc",load,policy);
  await cache.read("solana:AbC",load,policy);
  assert.equal(calls,4,"oldest entry is evicted at the configured bound");
});
