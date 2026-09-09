import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeResourceClient,nativeResourceProjection,type ResourceSnapshot} from '../../lib/charmville/native-resource-client';
const snapshot:ResourceSnapshot={regionId:'public:meadow',serverNow:'2026-09-09T00:00:00Z',beds:[{id:0,stage:0,revision:'0',readyAt:null,planterId:null}],seeds:'3',produce:'0'};
const event={type:'charmville:action-lifecycle',sessionId:'11111111-1111-4111-8111-111111111111',localActionId:1,sequence:1,phase:'begin',action:'till',plotIndex:0,dmap:4,screen:63,x:24,y:72,direction:1};
test('native action authorizes before contact and commits one stable receipt ID',async()=>{
 const calls:Record<string,unknown>[]=[];const sent:Record<string,unknown>[]=[];let changed=0;
 const c=createNativeResourceClient({read:async()=>snapshot,actor:async()=>({sequence:3,regionEpoch:0}),post:async body=>{calls.push(body as Record<string,unknown>);},send:body=>sent.push(body as Record<string,unknown>),changed:()=>{changed++;},status:()=>{},uuid:()=> 'receipt'});
 await c.observe(event);assert.equal(calls[0].phase,'begin');assert(sent.some(v=>v.accepted===true));assert.equal(changed,0);
 await c.observe({...event,phase:'contact',sequence:2});await c.observe({...event,phase:'contact',sequence:2});assert.equal(calls.length,2);assert.equal(calls[1].requestId,'receipt');assert.equal(changed,1);assert(sent.some(v=>v.resolvedLocalActionId===1));c.dispose();
});
test('cancel while authorization is pending cannot authorize native animation',async()=>{
 let resolve!:()=>void;const pending=new Promise<void>(r=>{resolve=r;});const calls:string[]=[];const sent:Record<string,unknown>[]=[];
 const c=createNativeResourceClient({read:async()=>snapshot,actor:async()=>({sequence:0,regionEpoch:0}),post:async(body)=>{const phase=(body as {phase:string}).phase;calls.push(phase);if(phase==='begin')await pending;},send:body=>sent.push(body as Record<string,unknown>),changed:()=>{},status:()=>{},uuid:()=> 'receipt'});
 const begin=c.observe(event);await new Promise(r=>setTimeout(r,0));const cancel=c.observe({...event,phase:'cancel',sequence:2});resolve();await Promise.all([begin,cancel]);assert.deepEqual(calls,['begin','cancel']);assert(!sent.some(v=>v.accepted===true));c.dispose();
});
test('uncertain contact retries identical receipt without another begin',async()=>{
 const calls:object[]=[];let fail=true;const c=createNativeResourceClient({read:async()=>snapshot,actor:async()=>({sequence:0,regionEpoch:0}),post:async body=>{calls.push(body);if((body as {phase:string}).phase==='commit'&&fail){fail=false;throw Error('Lost response');}},send:()=>{},changed:()=>{},status:()=>{},uuid:()=> 'receipt'});
 await c.observe(event);await c.observe({...event,phase:'contact',sequence:2});assert.equal(calls.length,3);assert.deepEqual(calls[1],calls[2]);c.dispose();
});
test('growth art follows server clock rather than browser elapsed time',()=>{
 const projection=nativeResourceProjection({...snapshot,beds:[{id:0,stage:3,revision:'2',readyAt:'2026-09-09T00:00:05Z',planterId:'1'}]});assert.equal(projection.beds[0].growthVisualPhase,2);
});
