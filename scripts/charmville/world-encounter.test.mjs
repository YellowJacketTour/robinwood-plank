import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./world-encounter.js',import.meta.url),'utf8');
test('baseline, duplicate and stale events do not replay damage; expiry clears',()=>{
 let receive,poll,now=0;const parent={},files=new Map();
 vm.runInNewContext(source,{parent,window:{addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},Date:{now:()=>now},setInterval:fn=>poll=fn,clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},analyzePath:p=>({exists:files.has(p)}),readFile:p=>files.get(p),writeFile:(p,v)=>files.set(p,v)}});
 const send=(revision,eventId,hp=10,from=parent)=>{receive({source:from,origin:'http://localhost:3017',data:{type:'charmville:world-encounter',active:true,encounter:{id:'wild',speciesId:286,cell:{x:4,y:9},hp,maxHp:14,revision:String(revision)},damageEvent:{eventId,damage:2,actorId:"owned",actorSpeciesId:277,moveId:1,actorCell:{x:2,y:9}}}});poll();};
 const fields=()=>files.get('/Files/Homestead/charmville/world-encounter.txt').split('|');
 send(1,'1');assert.equal(fields()[6],'0');send(2,'2',8);assert.equal(fields()[6],'1');assert.deepEqual(fields().slice(8),['277','2','9','0']);send(2,'2',8);send(1,'1',10);send(2,'3',8);assert.equal(fields()[6],'1');assert.equal(fields()[4],'8');send(3,'4',6,{});assert.equal(fields()[4],'8');now=7000;poll();assert.equal(fields()[1],'0');
});
test('batch effects wait for native acknowledgment before advancing',()=>{
 let receive,poll;const parent={},files=new Map(),root='/Files/Homestead/charmville/';
 vm.runInNewContext(source,{parent,window:{addEventListener:(n,f)=>{if(n==='message')receive=f;}},Date:{now:()=>0},console,setInterval:f=>poll=f,clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},analyzePath:p=>({exists:files.has(p)}),readFile:p=>files.get(p),writeFile:(p,v)=>files.set(p,v)}});
 const send=(revision,ids)=>{receive({source:parent,origin:'http://localhost:3017',data:{type:'charmville:world-encounter',active:true,encounter:{id:'wild',speciesId:286,cell:{x:4,y:9},hp:8,maxHp:14,revision:String(revision)},damageEvents:ids.map(eventId=>({eventId,damage:2}))}});poll();};
 files.set(root+'encounter-effect-ack.txt','99');send(1,['1']);send(3,['1','2','3']);assert.equal(files.get(root+'world-encounter.txt').split('|')[6],'100');poll();assert.equal(files.get(root+'world-encounter.txt').split('|')[6],'100');files.set(root+'encounter-effect-ack.txt','100');poll();assert.equal(files.get(root+'world-encounter.txt').split('|')[6],'101');send(3,['2','3']);files.set(root+'encounter-effect-ack.txt','101');poll();assert.equal(files.get(root+'world-encounter.txt').split('|')[6],'101');
});
