import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeMovementClient,readNativePosition,type SavedActor} from '../../lib/charmville/native-movement-client';
const pos={type:'charmville:position-observed',sessionId:'11111111-1111-4111-8111-111111111111',sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,z:0,fakeZ:0,appliedCorrectionSequence:0,authority:'local-observation'};
const saved:SavedActor={profileId:'1',regionId:'public:meadow',presenceRevision:'1',geometryId:'native-adventure-d4-s63',geometryRevision:'a',tilePixels:8,cell:{x:2,y:9},sequence:0,regionEpoch:0,version:0};
test('movement waits for native spawn acknowledgment and sends only neighboring steps',async()=>{
 const bodies:object[]=[];const corrections:object[]=[];
 const client=createNativeMovementClient({request:async(body)=>{if(body)bodies.push(body);return saved;},correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);assert.equal(corrections.length,1);
 await client.observe({...pos,sequence:2,x:24});assert.equal(bodies.length,0);
 await client.observe({...pos,sequence:3,x:24,appliedCorrectionSequence:1});assert.equal(bodies.length,1);
 assert.deepEqual(bodies[0],{x:3,y:9,sequence:1,regionEpoch:0,presenceRevision:'1',geometryId:saved.geometryId});client.dispose();
});
test('missed cells are corrected, never interpolated or accepted as teleport',async()=>{
 const corrections:object[]=[];let posts=0;
 const client=createNativeMovementClient({request:async(body)=>{if(body)posts++;return saved;},correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);await client.observe({...pos,sequence:2,x:88,appliedCorrectionSequence:1});assert.equal(posts,0);assert.equal(corrections.length,2);client.dispose();
});
test('ambiguous movement result recovers committed server state instead of double stepping',async()=>{
 let gets=0,posts=0;const corrections:Record<string,unknown>[]=[];
 const client=createNativeMovementClient({request:async(body)=>{if(body){posts++;throw Error('Network interrupted');}gets++;return gets===1?saved:{...saved,cell:{x:3,y:9},sequence:1};},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe(pos);await client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});assert.equal(posts,1);assert.equal(gets,2);assert.equal(corrections[1].x,24);client.dispose();
});
test('disposed or wrong-map observations cannot move saved actor',async()=>{
 let requests=0;const client=createNativeMovementClient({request:async()=>{requests++;return saved;},correct:()=>{},status:()=>{}});
 assert.equal(readNativePosition({...pos,x:Infinity}),null);await client.observe({...pos,dmap:5});assert.equal(requests,0);client.dispose();await client.observe(pos);assert.equal(requests,0);
});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
test('queued steps are paced from response completion under variable latency',async()=>{
 let posts=0,acknowledged=0,nextSent=0;
 const client=createNativeMovementClient({request:async body=>{
  if(!body)return saved;
  const b=body as {x:number;sequence:number};posts++;
  if(posts===1){await new Promise(resolve=>setTimeout(resolve,140));acknowledged=Date.now();}else nextSent=Date.now();
  return {...saved,cell:{x:b.x,y:9},sequence:b.sequence};
 },correct:()=>{},status:()=>{}});
 await client.observe(pos);
 const first=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 const second=client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});
 await Promise.all([first,second]);
 assert(nextSent-acknowledged>=95,'A delayed acknowledgment must not cause a burst of queued steps');
 client.dispose();
});
test('inflight observations preserve every real neighboring cell under latency',async()=>{
 const step=deferred<SavedActor>();const cells:number[]=[];const corrections:object[]=[];
 const client=createNativeMovementClient({request:async body=>{if(!body)return saved;const b=body as {x:number;sequence:number};cells.push(b.x);return cells.length===1?step.promise:{...saved,cell:{x:b.x,y:9},sequence:b.sequence};},correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);const first=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 const second=client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});const third=client.observe({...pos,sequence:4,x:40,appliedCorrectionSequence:1});
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await Promise.all([first,second,third]);
 assert.deepEqual(cells,[3,4,5]);assert.equal(corrections.length,1);client.dispose();
});
test('presence refresh cannot rewind coordinates or be undone by older inflight response',async()=>{
 const step=deferred<SavedActor>();const bodies:{x:number;sequence:number;presenceRevision:string}[]=[];
 const client=createNativeMovementClient({request:async body=>{if(!body)return saved;const b=body as typeof bodies[number];bodies.push(b);return bodies.length===1?step.promise:{...saved,cell:{x:b.x,y:9},sequence:b.sequence};},correct:()=>{},status:()=>{}});
 await client.observe(pos);const moving=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 client.synchronize({...saved,presenceRevision:'2',cell:{x:20,y:20},sequence:50});
 client.synchronize({...saved,presenceRevision:'99',regionId:'other'});
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await moving;
 await client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});
 assert.equal(bodies[1].presenceRevision,'2');assert.equal(bodies[1].sequence,2);assert.equal(bodies[1].x,4);client.dispose();
});
test('new native session discards old inflight result and requests a fresh spawn',async()=>{
 const step=deferred<SavedActor>();let gets=0;const corrections:Record<string,unknown>[]=[];
 const client=createNativeMovementClient({request:async body=>{if(body)return step.promise;gets++;return saved;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe(pos);const moving=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 const newSession='22222222-2222-4222-8222-222222222222';const reset=client.observe({...pos,sessionId:newSession});
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await Promise.all([moving,reset]);
 assert.equal(gets,2);assert.equal(corrections.length,2);assert.equal(corrections[1].sessionId,newSession);assert.equal(corrections[1].x,16);client.dispose();
});
test('admission renewal race retries same uncommitted step once without snapping',async()=>{
 let gets=0;const bodies:Record<string,unknown>[]=[];const corrections:object[]=[];
 const client=createNativeMovementClient({request:async body=>{if(!body){gets++;return {...saved,presenceRevision:gets===1?'1':'2'};}bodies.push(body as Record<string,unknown>);if(bodies.length===1)throw Error('Admission changed');return {...saved,presenceRevision:'2',cell:{x:3,y:9},sequence:1};},correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);await client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 assert.equal(bodies.length,2);assert.equal(bodies[0].sequence,1);assert.equal(bodies[1].sequence,1);assert.equal(bodies[1].presenceRevision,'2');assert.equal(corrections.length,1);client.dispose();
});
test('rejected inflight movement clears queued pre-correction positions',async()=>{
 const step=deferred<SavedActor>();let posts=0;const corrections:Record<string,unknown>[]=[];
 const client=createNativeMovementClient({request:async body=>{if(!body)return saved;posts++;return step.promise;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe(pos);const moving=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 const queued=client.observe({...pos,sequence:3,x:80,appliedCorrectionSequence:1});
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await Promise.all([moving,queued]);
 assert.equal(posts,1);assert.equal(corrections.length,2);
 await client.observe({...pos,sequence:4,x:32,appliedCorrectionSequence:1});assert.equal(posts,1);client.dispose();
});
