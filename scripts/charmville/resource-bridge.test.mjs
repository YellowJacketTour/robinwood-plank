import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./resource-bridge.js',import.meta.url),'utf8');
function setup(){let poll,receive,now=1,uuid=0;const files=new Map(),messages=[],root='/Files/Homestead/charmville/';const parent={postMessage:(m,o)=>{if(o==='http://localhost:3017')messages.push(m);}};
 vm.runInNewContext(code,{parent,window:{addEventListener:(k,f)=>{if(k==='message')receive=f;}},crypto:{randomUUID:()=>String(++uuid)},Date:{now:()=>now},console,setInterval:f=>{poll=f;},clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},analyzePath:p=>({exists:files.has(p)}),readFile:p=>files.get(p),writeFile:(p,v)=>files.set(p,v)}});
 files.set(root+'action-run.txt','1');files.set(root+'lifecycle-sequence.txt','0');
 return {files,root,messages,poll:()=>poll(),expire:()=>{now+=16000;poll();},send:(data,source=parent)=>receive({data,source,origin:'http://localhost:3017'})};}
const snapshot={type:'charmville:resource-state',active:true,beds:[0,1,2].map(id=>({id,stage:0,growthVisualPhase:0})),seeds:3,produce:0};
test('per-bed permissions default denied and preserve distinct server actions',()=>{const f=setup();f.poll();f.send(snapshot);f.poll();assert.deepEqual(f.files.get(f.root+'resource-state.txt').split('|').slice(11),['0','0','0']);f.send({...snapshot,beds:snapshot.beds.map((b,i)=>({...b,allowedActions:i===0?['till','plant','water','harvest']:i===1?['water']:[]}))});f.poll();assert.deepEqual(f.files.get(f.root+'resource-state.txt').split('|').slice(11),['15','4','0']);});
test('starts locked and projects valid server state; expiry locks without local growth',()=>{const f=setup();f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[1],'0');f.send(snapshot);f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[1],'1');f.expire();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[1],'0');});
test('lifecycle emits once and authorization requires matching parent and session',()=>{const f=setup();f.poll();f.files.set(f.root+'lifecycle-1.txt','1|7|0|0|0|4|63|24|72|1');f.files.set(f.root+'lifecycle-sequence.txt','1');f.poll();f.poll();assert.equal(f.messages.length,1);assert.equal(f.messages[0].phase,'begin');const reply={type:'charmville:action-authorization',sessionId:f.messages[0].sessionId,localActionId:7,accepted:true};f.send(reply,{});assert(!f.files.has(f.root+'resource-authorization.txt'));f.send({...reply,sessionId:'wrong'});assert(!f.files.has(f.root+'resource-authorization.txt'));f.send(reply);assert.equal(f.files.get(f.root+'resource-authorization.txt'),'7|1');});
test('invalid bed data rejected and foreign receipt cannot unlock an action',()=>{const f=setup();f.poll();f.send({...snapshot,beds:[]});f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[1],'0');f.send({...snapshot,sessionId:'foreign',resolvedLocalActionId:99});f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[2],'0');});
test('ordinary snapshots cannot erase a receipt before the next native flush',()=>{const f=setup();f.poll();f.files.set(f.root+'lifecycle-1.txt','1|3|0|2|0|4|63|24|72|1');f.files.set(f.root+'lifecycle-sequence.txt','1');f.poll();const sessionId=f.messages[0].sessionId;f.send({...snapshot,sessionId,resolvedLocalActionId:3});f.send(snapshot);f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[2],'3');f.send({...snapshot,sessionId,resolvedLocalActionId:1});f.poll();assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[2],'3');});

const heart={...snapshot,protocolVersion:2,beds:snapshot.beds.map((b,id)=>({...b,stage:1,cropId:id===0?'burning-heart':'oran-berry',plantCrops:['oran-berry','burning-heart'],allowedActions:['plant']})),cropBalances:{'oran-berry':{seeds:3,produce:0},'burning-heart':{seeds:2,produce:1}}};
test('v2 file carries separate identities, balances and choices while legacy art stays locked',()=>{
 const f=setup();f.files.set(f.root+'resource-protocol.txt','2');f.poll();assert.equal(f.messages[0].type,'charmville:resource-capabilities');
 f.send(heart);f.poll();const fields=f.files.get(f.root+'resource-state-v2.txt').split('|').map(Number);
 assert.equal(fields.length,25);assert.equal(fields[1],1);assert.deepEqual(fields.slice(14),[2,2,1,1,3,0,2,1,3,3,3]);
 assert.equal(f.files.get(f.root+'resource-state.txt').split('|')[1],'0');
 f.files.set(f.root+'lifecycle-1.txt','1|7|0|1|0|4|63|24|72|1|2');f.files.set(f.root+'lifecycle-sequence.txt','1');f.poll();
 const action=f.messages.find(m=>m.type==='charmville:action-lifecycle');assert.equal(action.cropId,'burning-heart');assert.equal(action.protocolVersion,2);
 f.expire();assert.equal(f.files.get(f.root+'resource-state-v2.txt').split('|')[1],'0');
});
test('old native cannot accept Heart and new native retains Oran server fallback',()=>{
 const old=setup();old.poll();old.send(heart);old.poll();assert.equal(old.files.get(old.root+'resource-state.txt').split('|')[1],'0');
 const modern=setup();modern.files.set(modern.root+'resource-protocol.txt','2');modern.poll();modern.send(snapshot);modern.poll();
 assert.equal(modern.files.get(modern.root+'resource-state.txt').split('|')[1],'1');assert.equal(modern.files.get(modern.root+'resource-state-v2.txt').split('|')[1],'0');
});
