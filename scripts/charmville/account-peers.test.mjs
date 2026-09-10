import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('./account-peers.js',import.meta.url),'utf8');
function setup(){let handler,poll,now=1;const files=new Map(),parent={};vm.runInNewContext(code,{parent,window:{addEventListener:(type,fn)=>{if(type==='message')handler=fn;}},Date:{now:()=>now},setInterval:fn=>{poll=fn;},clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},writeFile:(p,v)=>files.set(p,v)}});return {read:()=>[...files.values()][0],poll:()=>poll(),advance:(ms=7000)=>{now+=ms;poll();},send:(data,source=parent)=>handler({data,source,origin:'http://localhost:3017'})};}
test('embedded mode starts empty, projects bounded peers and expires without guest fallback',()=>{const f=setup();f.poll();assert.equal(f.read(),'1|0');f.send({type:'charmville:account-peers',active:true,peers:[{profileId:'p',handle:'peer',x:24,y:72}]});assert.equal(f.read(),'1|1|24|72|1');f.advance();assert.equal(f.read(),'1|0');});
test('rejects invalid parent, non-grid positions and duplicate identities',()=>{const f=setup();f.poll();const p={profileId:'p',handle:'peer',x:24,y:72},data={type:'charmville:account-peers',active:true,peers:[p]};f.send(data,{});assert.equal(f.read(),'1|0');f.send({...data,peers:[{...p,x:25}]});assert.equal(f.read(),'1|0');f.send({...data,peers:[p,p]});assert.equal(f.read(),'1|0');});
test('neighbor steps interpolate without extrapolation or restarting on duplicate snapshots',()=>{
 const f=setup(),p={profileId:'p',handle:'peer',x:24,y:72};
 const send=x=>f.send({type:'charmville:account-peers',active:true,peers:[{...p,x}]});
 send(24);send(32);f.advance(50);assert.equal(f.read(),'1|1|28|72|3');
 send(32);f.advance(50);assert.equal(f.read(),'1|1|32|72|3');
 f.advance(500);assert.equal(f.read(),'1|1|32|72|3');
 send(96);assert.equal(f.read(),'1|1|96|72|3');
 f.send({type:'charmville:account-peers',active:false,peers:[]});assert.equal(f.read(),'1|0');
});
test('facing follows identity across reorder and stays stable while idle',()=>{const f=setup(),a={profileId:'a',handle:'a',x:24,y:72},b={profileId:'b',handle:'b',x:80,y:72};const send=peers=>f.send({type:'charmville:account-peers',active:true,peers});send([a,b]);send([{...b,y:64},{...a,x:32}]);f.advance(100);assert.equal(f.read(),'1|2|80|64|32|72|0|3');send([{...a,x:32},{...b,y:64}]);assert.equal(f.read(),'1|2|32|72|80|64|3|0');});
