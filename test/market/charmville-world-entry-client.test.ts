import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestWorldEntry} from '../../lib/charmville/world-entry-client';
const entry={destination:'home' as const,handle:'friend',revision:'17'};

test('lost admission response retries identical destination and expected revision once',async()=>{
 const sent:object[]=[];
 const original={...entry};
 const result=await requestWorldEntry({entry:original,request:async body=>{
  sent.push(body);
  if(sent.length===1){original.revision='18';throw new TypeError('Failed to fetch');}
  return {revision:'18'};
 }});
 assert.deepEqual(result,{revision:'18'});
 assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);
 assert.deepEqual(sent[1],entry);
});

test('authorization, permission, stale revision and throttle failures are not retried',async()=>{
 for(const status of [400,401,403,404,409,429]){
  let sends=0;const failure=Object.assign(new Error('Denied'),{status});
  await assert.rejects(requestWorldEntry({entry,request:async()=>{sends++;throw failure;}}),error=>error===failure);
  assert.equal(sends,1);
 }
});

test('transient server errors have a strict two-send bound',async()=>{
 for(const status of [500,502,503,504]){
  let sends=0;
  await assert.rejects(requestWorldEntry({entry,request:async()=>{sends++;throw Object.assign(new Error('Unavailable'),{status});}}),/Unavailable/);
  assert.equal(sends,2);
 }
});

test('cancellation and superseded navigation prevent a second admission send',async()=>{
 for(const cancel of ['signal','generation']){
  const controller=new AbortController();let generation=1,sends=0;
  await assert.rejects(requestWorldEntry({entry,signal:controller.signal,isCurrent:()=>generation===1,request:async()=>{
   sends++;if(cancel==='signal')controller.abort();else generation++;
   throw new TypeError('Failed to fetch');
  }}),/Failed to fetch/);
  assert.equal(sends,1);
 }
});

test('already cancelled admission sends nothing',async()=>{
 const controller=new AbortController();controller.abort();let sends=0;
 await assert.rejects(requestWorldEntry({entry,signal:controller.signal,request:async()=>{sends++;}}),{name:'AbortError'});
 assert.equal(sends,0);
});
