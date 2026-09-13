import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./position-observer.js',import.meta.url),'utf8');
function fixture(){let poll,receive,id=0;const files=new Map(),messages=[],root='/Files/Homestead/charmville/';
 const parent={postMessage:(m,o)=>{if(o==='http://localhost:3017')messages.push(m);}};
 const context={parent,window:{addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},crypto:{randomUUID:()=>String(++id)},setInterval:fn=>{poll=fn;},clearInterval(){},FS:{cwd:()=> '/',analyzePath:p=>({exists:files.has(p)}),readFile:p=>files.get(p),writeFile:(p,v)=>files.set(p,v)}};
 vm.runInNewContext(code,context);files.set(root+'action-run.txt','1');files.set(root+'position.txt','1|4|63|16.5|72|3|0|0|0');
 return {poll:()=>poll(),messages,files,root,send:(data,source=parent,origin='http://localhost:3017')=>receive({data,source,origin})};
}
test('preserves fractional source coordinates and deduplicates snapshots',()=>{const f=fixture();f.poll();f.poll();assert.equal(f.messages.length,1);assert.equal(f.messages[0].x,16.5);assert.equal(f.messages[0].appliedCorrectionSequence,0);});
test('corrections require real parent, current session, grid bounds and sequence',()=>{
 const f=fixture();f.poll();const c={type:'charmville:position-correction',sessionId:f.messages[0].sessionId,sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,reason:'spawn'};
 f.send(c,{});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send({...c,x:17});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send({...c,sessionId:'stale'});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send(c);assert.equal(f.files.get(f.root+'position-correction.txt'),'1|4|63|16|72|1');
 f.send({...c,x:24});assert.equal(f.files.get(f.root+'position-correction.txt'),'1|4|63|16|72|1');
});
