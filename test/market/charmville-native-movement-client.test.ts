import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeMovementClient,readNativePosition,type SavedActor} from '../../lib/charmville/native-movement-client';
const pos={type:'charmville:position-observed',sessionId:'11111111-1111-4111-8111-111111111111',sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,z:0,fakeZ:0,appliedCorrectionSequence:0,authority:'local-observation'};
const saved:SavedActor={profileId:'1',regionId:'public:meadow',presenceRevision:'1',geometryId:'native-adventure-d4-s63',geometryRevision:'a',tilePixels:8,cell:{x:2,y:9},sequence:0,regionEpoch:0,version:0};

test('backlog metrics retain overflow evidence without exposing account data',async()=>{
 const blocked=deferred<SavedActor>();
 const client=createNativeMovementClient({request:async body=>body?blocked.promise:saved,correct:()=>{},status:()=>{}});
 await client.observe(pos);
 const draining=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 for(let i=0;i<70;i++)void client.observe({...pos,sequence:i+3,x:i%2?32:40,appliedCorrectionSequence:1});
 const metrics=client.metrics();assert.equal(metrics.droppedPaths,1);assert.equal(metrics.queueHighWater,64);
 assert.ok(metrics.queued<64);assert.ok(metrics.oldestQueuedMs>=0);
 assert.equal('profileId' in metrics,false);
 client.dispose();blocked.resolve(saved);await draining;
});
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
 await client.observe(pos);await client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});assert.equal(posts,1);assert.equal(gets,2);assert.equal(corrections.length,1,'An exact committed step needs no native warp');client.dispose();
});
test('lost acknowledgment preserves an observed direction reversal without snap or duplicate step',async()=>{
 const recovery=deferred<SavedActor>();let gets=0;const bodies:{x:number;sequence:number}[]=[];const corrections:object[]=[];
 const client=createNativeMovementClient({request:async body=>{
  if(!body){gets++;return gets===1?saved:recovery.promise;}
  const b=body as typeof bodies[number];bodies.push(b);
  if(bodies.length===1)throw Error('Response lost after commit');
  return {...saved,cell:{x:b.x,y:9},sequence:b.sequence};
 },correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);
 const moving=client.observe({...pos,sequence:2,x:24,direction:3,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:3,x:23,direction:2,appliedCorrectionSequence:1});
 recovery.resolve({...saved,cell:{x:3,y:9},sequence:1});await moving;
 assert.deepEqual(bodies.map(b=>[b.x,b.sequence]),[[3,1],[2,2]]);
 assert.equal(corrections.length,1);client.dispose();
});
test('ambiguous recovery from another authority step still corrects native position',async()=>{
 let gets=0;const corrections:Record<string,unknown>[]=[];
 const client=createNativeMovementClient({request:async body=>{if(body)throw Error('Response lost');gets++;return gets===1?saved:{...saved,cell:{x:3,y:9},sequence:2};},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe(pos);await client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 assert.equal(corrections.length,2);assert.equal(corrections[1].x,24);client.dispose();
});
test('disposed or wrong-map observations cannot move saved actor',async()=>{
 let requests=0;const client=createNativeMovementClient({request:async()=>{requests++;return saved;},correct:()=>{},status:()=>{}});
 assert.equal(readNativePosition({...pos,x:Infinity}),null);await client.observe({...pos,dmap:5});assert.equal(requests,0);client.dispose();await client.observe(pos);assert.equal(requests,0);
});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
test('stationary frame backlog cannot evict observed path cells during a slow acknowledgment',async()=>{
 const step=deferred<SavedActor>();const cells:number[]=[];const corrections:object[]=[];
 const client=createNativeMovementClient({request:async body=>{if(!body)return saved;const b=body as {x:number;sequence:number};cells.push(b.x);return cells.length===1?step.promise:{...saved,cell:{x:b.x,y:9},sequence:b.sequence};},correct:p=>corrections.push(p),status:()=>{}});
 await client.observe(pos);
 const moving=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});
 // The next real cell is reached, followed by many frames in that same cell.
 for(let sequence=4;sequence<80;sequence++)void client.observe({...pos,sequence,x:40+sequence%8,appliedCorrectionSequence:1});
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await moving;
 assert.deepEqual(cells,[3,4,5]);
 assert.equal(corrections.length,1,'Repeated frames must not create a false missed-cell correction');
 client.dispose();
});
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
test('negotiated walking spends response latency inside its cadence instead of adding it to every step',async()=>{
 const sent:number[]=[],acks:number[]=[];const bodies:Record<string,unknown>[]=[];
 const client=createNativeMovementClient({request:async body=>{
  if(!body)return {...saved,pacedMovement:true};
  const b=body as {x:number;sequence:number};bodies.push(body as Record<string,unknown>);sent.push(Date.now());
  await new Promise(resolve=>setTimeout(resolve,70));acks.push(Date.now());
  return {...saved,pacedMovement:true,cell:{x:b.x,y:9},sequence:b.sequence};
 },correct:()=>{},status:()=>{}});
 await client.observe(pos);
 const walking=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});
 await walking;
 assert.equal(bodies.length,2);assert(bodies.every(body=>body.waitForTurn===true));
 assert(sent[1]-sent[0]>=95,'Dispatches must preserve the walking interval');
 assert(sent[1]-acks[0]<80,'An acknowledged turn must not add another full100ms');
 client.dispose();
});
test('negotiated slow replies cannot produce catch-up bursts from an old dispatch deadline',async()=>{
 const sent:number[]=[];
 const client=createNativeMovementClient({request:async body=>{
  if(!body)return {...saved,pacedMovement:true};
  const b=body as {x:number;sequence:number};sent.push(Date.now());
  if(sent.length===1)await new Promise(resolve=>setTimeout(resolve,160));
  return {...saved,pacedMovement:true,cell:{x:b.x,y:9},sequence:b.sequence};
 },correct:()=>{},status:()=>{}});
 await client.observe(pos);
 const walking=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:3,x:32,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:4,x:40,appliedCorrectionSequence:1});
 await walking;
 assert.equal(sent.length,3);assert(sent[2]-sent[1]>=95,'Each dispatch must start a new cadence interval');
 client.dispose();
});
test('negotiated diagonal walking retains the longer diagonal cadence',async()=>{
 const sent:number[]=[];
 const client=createNativeMovementClient({request:async body=>{
  if(!body)return {...saved,pacedMovement:true};
  const b=body as {x:number;y:number;sequence:number};sent.push(Date.now());
  return {...saved,pacedMovement:true,cell:{x:b.x,y:b.y},sequence:b.sequence};
 },correct:()=>{},status:()=>{}});
 await client.observe(pos);
 const walking=client.observe({...pos,sequence:2,x:24,y:80,appliedCorrectionSequence:1});
 void client.observe({...pos,sequence:3,x:32,y:88,appliedCorrectionSequence:1});
 await walking;
 assert.equal(sent.length,2);assert(sent[1]-sent[0]>=137,'Diagonal steps preserve142ms dispatch spacing');
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


test('reconnected controller advances past the running native correction receipt',async()=>{
 const corrections:Record<string,unknown>[]=[];let posts=0;
 const client=createNativeMovementClient({request:async body=>{if(body)posts++;return saved;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe({...pos,appliedCorrectionSequence:7});
 assert.equal(corrections[0].sequence,8);
 await client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:7});
 assert.equal(posts,0);
 await client.observe({...pos,sequence:3,x:24,appliedCorrectionSequence:8});
 assert.equal(posts,1);client.dispose();
});

test('lost native placement is retried without accepting movement before acknowledgment',async()=>{
 const corrections:Record<string,unknown>[]=[];let posts=0;
 const client=createNativeMovementClient({request:async body=>{if(body)posts++;return saved;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe(pos);
 await new Promise(resolve=>setTimeout(resolve,1510));
 await client.observe({...pos,sequence:2,x:24});
 assert.equal(corrections.length,2);assert.equal(corrections[1].sequence,2);assert.equal(posts,0);
 await client.observe({...pos,sequence:3,x:24,appliedCorrectionSequence:2});
 assert.equal(posts,1);client.dispose();
});


test('explicit admission reconnect places a grounded player from another screen without posting movement',async()=>{
 const corrections:Record<string,unknown>[]=[];let gets=0,posts=0;
 const client=createNativeMovementClient({allowArrivalWarp:true,request:async body=>{if(body)posts++;else gets++;return {...saved,regionId:'home:1',regionEpoch:2};},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe({...pos,screen:62,z:8,appliedCorrectionSequence:9});
 assert.equal(gets,0,'Arrival waits for landing');
 await client.observe({...pos,sequence:2,screen:62,appliedCorrectionSequence:9});
 assert.equal(gets,1);assert.equal(posts,0);
 assert.deepEqual(corrections[0],{type:'charmville:position-correction',sessionId:pos.sessionId,sequence:10,dmap:4,screen:63,x:16,y:72,direction:1,reason:'spawn'});
 await client.observe({...pos,sequence:3,appliedCorrectionSequence:10});
 await client.observe({...pos,sequence:4,screen:62,appliedCorrectionSequence:10});
 assert.equal(corrections.length,1,'Ordinary exploration must not trigger another arrival warp');
 assert.equal(posts,0);client.dispose();
});

test('new admission controller can return an existing native session while default callers cannot warp',async()=>{
 let gets=0;const corrections:object[]=[];
 const options={request:async()=>{gets++;return saved;},correct:(p:object)=>corrections.push(p),status:()=>{}};
 const passive=createNativeMovementClient(options);
 await passive.observe({...pos,dmap:5});passive.dispose();assert.equal(gets,0);
 const admitted=createNativeMovementClient({...options,allowArrivalWarp:true});
 await admitted.observe({...pos,dmap:5});
 assert.equal(gets,1);assert.equal(corrections.length,1);admitted.dispose();
});


test('lost cross-screen arrival retries only until acknowledged on the supported map',async()=>{
 const corrections:Record<string,unknown>[]=[];let posts=0;
 const client=createNativeMovementClient({allowArrivalWarp:true,request:async body=>{if(body)posts++;return saved;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe({...pos,screen:62});
 await client.observe({...pos,sequence:2,screen:62});assert.equal(corrections.length,1);
 await new Promise(resolve=>setTimeout(resolve,1510));
 await client.observe({...pos,sequence:3,screen:62});
 assert.equal(corrections.length,2);assert.equal(corrections[1].reason,'spawn');assert.equal(corrections[1].sequence,2);
 await client.observe({...pos,sequence:4,appliedCorrectionSequence:2});
 await client.observe({...pos,sequence:5,screen:62,appliedCorrectionSequence:2});
 assert.equal(corrections.length,2);assert.equal(posts,0);client.dispose();
});

test('connected border requests explicit travel and accepts destination placement',async()=>{
 const bodies:object[]=[];const corrections:Record<string,unknown>[]=[];
 const start={...saved,native:{dmap:4,screen:63},cell:{x:0,y:9}};
 const arrived={...start,native:{dmap:4,screen:62},geometryId:'native-adventure-d4-s62',geometryRevision:'b',regionEpoch:1,cell:{x:30,y:9}};
 const client=createNativeMovementClient({allowArrivalWarp:true,allowBorderTravel:true,request:async body=>{if(body)bodies.push(body);return body?arrived:start;},correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{}});
 await client.observe({...pos,x:0});
 await client.observe({...pos,sequence:2,x:240,screen:62,appliedCorrectionSequence:1});
 assert.equal(bodies.length,1);assert.equal((bodies[0] as {destination:string}).destination,arrived.geometryId);
 assert.equal(corrections[1].screen,62);assert.equal(corrections[1].x,240);
 client.dispose();
});

test('border travel is paced after the final walking acknowledgment',async()=>{
 let state:SavedActor={...saved,native:{dmap:4,screen:63},cell:{x:1,y:9}};
 let acknowledged=0,crossed=0;
 const client=createNativeMovementClient({allowBorderTravel:true,request:async body=>{
  if(!body)return state;
  if('destination' in body){crossed=Date.now();return {...state,native:{dmap:4,screen:62},geometryId:'native-adventure-d4-s62',regionEpoch:1,cell:{x:30,y:9}};}
  state={...state,cell:{x:0,y:9},sequence:1};acknowledged=Date.now();return state;
 },correct:()=>{},status:()=>{}});
 await client.observe({...pos,x:8});
 await client.observe({...pos,sequence:2,x:0,appliedCorrectionSequence:1});
 await client.observe({...pos,sequence:3,x:240,screen:62,appliedCorrectionSequence:1});
 assert.ok(crossed-acknowledged>=95,`travel arrived after ${crossed-acknowledged}ms`);
 client.dispose();
});


test('overflow cannot silently resume an adjacent tail after losing the observed trail',async()=>{
 const step=deferred<SavedActor>();const bodies:{x:number;sequence:number}[]=[];
 const corrections:Record<string,unknown>[]=[];const causes:string[]=[];
 const client=createNativeMovementClient({request:async body=>{
  if(!body)return saved;
  const b=body as typeof bodies[number];bodies.push(b);
  return bodies.length===1?step.promise:{...saved,cell:{x:b.x,y:9},sequence:b.sequence};
 },correct:p=>corrections.push(p as Record<string,unknown>),status:()=>{},diagnostic:e=>causes.push(e.cause)});
 await client.observe(pos);
 const moving=client.observe({...pos,sequence:2,x:24,appliedCorrectionSequence:1});
 for(let i=0;i<65;i++)void client.observe({...pos,sequence:i+3,x:i%2?32:40,appliedCorrectionSequence:1});
 // This newest point happens to be adjacent to the in-flight committed cell.
 // Adjacency alone cannot repair the missing path or authorize the tail.
 void client.observe({...pos,sequence:68,x:32,appliedCorrectionSequence:1});
 assert.equal(client.metrics().resynchronizing,true);
 step.resolve({...saved,cell:{x:3,y:9},sequence:1});await moving;
 assert.equal(bodies.length,1);assert.equal(corrections.length,2);
 assert.equal(corrections[1].x,24);
 assert.equal(causes[1],'observation-backlog-overflow');
 assert.equal(client.metrics().resynchronizing,false);
 await client.observe({...pos,sequence:69,x:32,appliedCorrectionSequence:1});
 assert.equal(bodies.length,1,'Old receipt cannot bypass the resynchronization barrier');
 await client.observe({...pos,sequence:70,x:32,appliedCorrectionSequence:2});
 assert.equal(bodies.length,2);assert.equal(bodies[1].sequence,2);
 client.dispose();
});
