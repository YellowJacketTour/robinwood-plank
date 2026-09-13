import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./position-observer.js',import.meta.url),'utf8');
function fixture(standalone=false){let poll,receive,id=0;const classes=new Set();let notice=null;const files=new Map(),messages=[],root='/Files/Homestead/charmville/';
 const parent={postMessage:(m,o)=>{if(o==='http://localhost:3017')messages.push(m);}};
 const document={addEventListener(){},body:{classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}},getElementById:()=>notice,createElement:()=>({setAttribute(){},hidden:false}),querySelector:()=>({after:node=>{notice=node;}})};
 const context={document,parent,window:{addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},crypto:{randomUUID:()=>String(++id)},setInterval:fn=>{poll=fn;},clearInterval(){},FS:{cwd:()=> '/',analyzePath:p=>({exists:files.has(p)}),readFile:p=>files.get(p),writeFile:(p,v)=>files.set(p,v)}};
 if(standalone){context.parent=context.window;context.location={search:'?test=/quests/charmville/homestead-region/r01/Homestead.qst'};context.URLSearchParams=URLSearchParams;}
 vm.runInNewContext(code,context);files.set(root+'action-run.txt','1');files.set(root+'position.txt','1|4|63|16.5|72|3|0|0|0');
 return {classes,poll:()=>poll(),messages,files,root,send:(data,source=parent,origin='http://localhost:3017')=>receive({data,source,origin})};
}
test('standalone joined world conceals source spawn until native authored placement is observed',()=>{
 const f=fixture(true);assert(f.classes.has('charm-arrival-pending'));
 f.files.set(f.root+'position.txt','1|4|62|488|72|1|0|0|0|10|2|1');f.poll();assert(f.classes.has('charm-arrival-pending'));
 f.files.set(f.root+'position.txt','2|4|62|272|72|1|0|0|0|10|2|1');f.poll();assert(!f.classes.has('charm-arrival-pending'));
 assert.equal(f.messages.length,0);assert(!f.files.has(f.root+'position-correction.txt'));
});
test('preserves fractional source coordinates and deduplicates snapshots',()=>{const f=fixture();f.poll();f.poll();assert.equal(f.messages.length,1);assert.equal(f.messages[0].x,16.5);assert.equal(f.messages[0].appliedCorrectionSequence,0);});
test('region samples preserve native location and normalize both axes at source seams',()=>{
 const f=fixture();
 f.files.set(f.root+'position.txt','1|4|46|272.5|248|3|0|0|0|10|2|2');f.poll();
 const m=f.messages[0];assert.equal(m.screen,63);assert.equal(m.x,16.5);assert.equal(m.y,72);
 assert.equal(m.region.origin,46);assert.equal(m.region.x,272.5);assert.equal(m.region.y,248);
 f.files.set(f.root+'position.txt','2|4|46|256|176|1|0|0|0|10|2|2');f.poll();
 assert.equal(f.messages[1].screen,63);assert.equal(f.messages[1].x,0);assert.equal(f.messages[1].y,0);
});
test('invalid region rectangles and positions never publish or consume sequence',()=>{
 const f=fixture();
 for(const sample of ['1|4|47|0|0|1|0|0|0|10|2|2','1|4|46|512|0|1|0|0|0|10|2|2','1|4|46|0|352|1|0|0|0|10|2|2','1|4|46|-1|0|1|0|0|0|10|2|2']){f.files.set(f.root+'position.txt',sample);f.poll();assert.equal(f.messages.length,0);}
 f.files.set(f.root+'position.txt','1|4|46|0|0|1|0|0|0|10|2|2');f.poll();assert.equal(f.messages.length,1);
});
test('delayed polling preserves recorded corner samples in order',()=>{
 const f=fixture();f.poll();
 f.files.set(f.root+'position-2.txt','2|4|63|24|72|3|0|0|0');
 f.files.set(f.root+'position-3.txt','3|4|63|24|80|1|0|0|0');
 f.files.set(f.root+'position.txt','4|4|63|32|80|3|0|0|0');f.poll();
 assert.deepEqual(f.messages.map(p=>[p.sequence,p.x,p.y]),[[1,16.5,72],[2,24,72],[3,24,80],[4,32,80]]);
 f.poll();assert.equal(f.messages.length,4);
});
test('overwritten history never fabricates a path',()=>{
 const f=fixture();f.poll();
 f.files.set(f.root+'position-2.txt','66|4|63|24|72|3|0|0|0');
 f.files.set(f.root+'position.txt','4|4|63|32|80|3|0|0|0');f.poll();
 assert.deepEqual(f.messages.map(p=>p.sequence),[1,4]);
});
test('corrections require real parent, current session, grid bounds and sequence',()=>{
 const f=fixture();f.poll();const c={type:'charmville:position-correction',sessionId:f.messages[0].sessionId,sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,reason:'spawn'};
 f.send(c,{});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send({...c,x:17});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send({...c,sessionId:'stale'});assert(!f.files.has(f.root+'position-correction.txt'));
 f.send(c);assert.equal(f.files.get(f.root+'position-correction.txt'),'1|4|63|16|72|1|0');
 f.send({...c,x:24});assert.equal(f.files.get(f.root+'position-correction.txt'),'1|4|63|16|72|1|0');
});

test('rejection marks facing as preserved instead of replaying the old turn',()=>{
 const f=fixture();f.poll();
 f.send({type:'charmville:position-correction',sessionId:f.messages[0].sessionId,sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,reason:'rejected'});
 assert.equal(f.files.get(f.root+'position-correction.txt'),'1|4|63|16|72|1|1');
});

test('embedded scene waits for the native acknowledgment of this run placement',()=>{
 const f=fixture();f.poll();assert(f.classes.has('charm-arrival-pending'));
 const c={type:'charmville:position-correction',sessionId:f.messages[0].sessionId,sequence:1,dmap:4,screen:63,x:16,y:72,direction:1,reason:'spawn'};
 f.send(c);assert(f.classes.has('charm-arrival-pending'));
 f.files.set(f.root+'position.txt','2|4|63|16|72|1|0|0|1');f.poll();assert(!f.classes.has('charm-arrival-pending'));
 f.files.set(f.root+'action-run.txt','2');f.poll();assert(f.classes.has('charm-arrival-pending'));
});
