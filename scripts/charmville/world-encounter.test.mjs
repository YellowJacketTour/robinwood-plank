import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./world-encounter.js',import.meta.url),'utf8');
test('baseline, duplicate and stale events do not replay damage; expiry clears',()=>{
 let receive,poll,now=0;const parent={},files=new Map();
 vm.runInNewContext(source,{parent,window:{addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},Date:{now:()=>now},setInterval:fn=>poll=fn,clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},writeFile:(p,v)=>files.set(p,v)}});
 const send=(revision,eventId,hp=10,from=parent)=>{receive({source:from,origin:'http://localhost:3017',data:{type:'charmville:world-encounter',active:true,encounter:{id:'wild',speciesId:286,cell:{x:4,y:9},hp,maxHp:14,revision:String(revision)},damageEvent:{eventId,damage:2}}});poll();};
 const fields=()=>files.get('/Files/Homestead/charmville/world-encounter.txt').split('|');
 send(1,'old');assert.equal(fields()[6],'0');send(2,'new',8);assert.equal(fields()[6],'1');send(2,'new',8);send(1,'old',10);send(2,'other',8);assert.equal(fields()[6],'1');assert.equal(fields()[4],'8');send(3,'foreign',6,{});assert.equal(fields()[4],'8');now=7000;poll();assert.equal(fields()[1],'0');
});
