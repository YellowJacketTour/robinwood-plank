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
