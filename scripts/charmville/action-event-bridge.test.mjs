import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./action-event-bridge.js',import.meta.url),'utf8');
function fixture(){
 const files=new Map(),messages=[];let poll,uuid=0;
 const prefix='/Files/Homestead/charmville/';
 files.set(prefix+'action-run.txt','1');
 const context={crypto:{randomUUID:()=> 'fixture-session-'+(++uuid)},parent:{postMessage:(data,origin)=>{if(origin==='http://localhost:3017')messages.push(data);}},window:{addEventListener(){}},setInterval:fn=>{poll=fn;},clearInterval(){},console,FS:{cwd:()=> '/',analyzePath:path=>({exists:files.has(path)}),readFile:path=>{if(!files.has(path))throw Error('missing');return files.get(path);}}};
 vm.runInNewContext(source,context);
 return {messages,poll:()=>poll(),run:n=>files.set(prefix+'action-run.txt',String(n)),event:(seq,action=0)=>files.set(prefix+`action-${seq%64}.txt`,`${seq}|${action}|0|4|63|24|72|1`),cursor:n=>files.set(prefix+'action-sequence.txt',String(n))};
}
test('drains each immutable sequence once and sends no reward authority',()=>{
 const f=fixture();f.event(1);f.event(2,1);f.cursor(2);f.poll();f.poll();
 assert.equal(f.messages.length,2);assert.equal(f.messages[0].action,'till');assert.equal(f.messages[1].action,'plant');
 assert.equal(f.messages[1].eventId,'fixture-session-1:2');assert.equal(f.messages[0].authority,'local-observation');assert(!('reward' in f.messages[0]));
});
test('reports overwritten ring entries instead of silently inventing them',()=>{
 const f=fixture();for(let n=3;n<=66;n++)f.event(n);f.cursor(66);f.poll();
 assert.equal(f.messages[0].type,'charmville:action-stream-gap');assert.equal(f.messages[0].fromSequence,1);assert.equal(f.messages[0].toSequence,2);assert.equal(f.messages.length,65);
});
test('does not consume wrong-slot sequence or unsupported actions',()=>{
 const f=fixture();f.event(65);f.cursor(1);f.poll();assert.equal(f.messages.length,0);
 f.event(1,99);f.poll();assert.equal(f.messages.length,0);
});
test('equal sequence after native restart gets a fresh event identity',()=>{
 const f=fixture();f.event(1);f.cursor(1);f.poll();f.run(2);f.event(1,1);f.poll();
 assert.equal(f.messages[1].type,'charmville:action-stream-reset');assert.notEqual(f.messages[0].eventId,f.messages[2].eventId);assert.equal(f.messages[2].action,'plant');
});
