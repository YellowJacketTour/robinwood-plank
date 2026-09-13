import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./follower-bridge.js',import.meta.url),'utf8');
test('six-party URL is confined to explicit standalone joined play',()=>{
 for(const [embedded,search,expected] of [[false,'?test=/quests/charmville/homestead-region/r01/Homestead.qst&testParty=6',true],[true,'?test=/quests/charmville/homestead-region/r01/Homestead.qst&testParty=6',false],[false,'?test=/quests/charmville/homestead/r01/Homestead.qst&testParty=6',false]]){
  const files=new Map();let tick;const window={addEventListener(){}};window.parent=embedded?{postMessage(){}}:window;
  vm.runInNewContext(source,{window,location:{search},document:{referrer:''},URL,URLSearchParams,setInterval(fn){tick=fn;},clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},writeFile:(p,v)=>files.set(p,v)}});tick();
  assert.equal(files.get('/Files/Homestead/charmville/party-followers.txt'),expected?'277|280|283|25|133|286|18':'0|0|0|0|0|0|18');
 }
});
test('unchanged six-member party is restored after quest files disappear or the mount changes',()=>{
 let receive,tick;let cwd='/';const files=new Map(),parent={postMessage(){}};let writes=0;
 const context={window:{parent,addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},document:{referrer:'http://localhost:3017/'},URL,setInterval(fn){tick=fn;},clearInterval(){},FS:{cwd:()=>cwd,mkdirTree(){},analyzePath:p=>({exists:files.has(p)}),writeFile:(p,v)=>{writes++;files.set(p,v);}}};
 vm.runInNewContext(source,context);
 receive({data:{type:'charmville:party-followers',speciesIds:[277,280,283,25,133,286]},source:parent,origin:'http://localhost:3017'});
 const path='/Files/Homestead/charmville/party-followers.txt';
 assert.equal(files.get(path),'277|280|283|25|133|286|18');
 tick();assert.equal(writes,3,'An intact projection should not be rewritten every timer tick');
 files.delete(path);tick();assert.equal(files.get(path),'277|280|283|25|133|286|18');
 cwd='/new-quest';tick();assert.equal(files.get('/new-quest'+path),'277|280|283|25|133|286|18');
 const afterChange=writes;context.FS={...context.FS};tick();assert.equal(writes,afterChange+3,'A replaced FS instance must receive the current projection');
});
test('six distinct projections and safe trail presets reject foreign or invalid messages',()=>{
 let receive;const files=new Map(),parent={postMessage(){}};
 vm.runInNewContext(source,{parent,window:{parent,addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},document:{referrer:'http://localhost:3017/charmville/world'},URL,setInterval(){},clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},writeFile:(p,value)=>files.set(p,value)}});
 const path='/Files/Homestead/charmville/party-followers.txt',send=(data,from=parent)=>receive({data,source:from,origin:'http://localhost:3017'});
 send({type:'charmville:party-followers',speciesIds:[277,280,283,25,133,286]});assert.equal(files.get(path),'277|280|283|25|133|286|18');
 send({type:'charmville:follower-formation',formation:'relaxed'},{});assert.equal(files.get(path),'277|280|283|25|133|286|18');
 send({type:'charmville:follower-formation',formation:'relaxed'});assert.equal(files.get(path),'277|280|283|25|133|286|26');
 send({type:'charmville:party-followers',speciesIds:[999]});assert.equal(files.get(path),'277|280|283|25|133|286|26');
 send({type:'charmville:party-followers',speciesIds:[]});assert.equal(files.get(path),'0|0|0|0|0|0|26');
});

test('UUID identity follows exact rendered slot, refreshes without species changes, and clears legacy metadata',()=>{
 let receive;const files=new Map(),parent={postMessage(){}};
 vm.runInNewContext(source,{window:{parent,addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},document:{referrer:'http://localhost:3017/'},URL,setInterval(){},clearInterval(){},FS:{cwd:()=> '/',mkdirTree(){},writeFile:(p,v)=>files.set(p,v)}});
 const path='/Files/Homestead/charmville/party-follower-ids.txt';
 const send=data=>receive({data,source:parent,origin:'http://localhost:3017'});
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 send({type:'charmville:party-followers',speciesIds:[277,277],creatureIds:[a,b]});assert.equal(files.get(path),`${a}|${b}||||`);
 send({type:'charmville:party-followers',speciesIds:[277,277],creatureIds:[b,a]});assert.equal(files.get(path),`${b}|${a}||||`);
 send({type:'charmville:party-followers',speciesIds:[277],creatureIds:['bad|identity']});assert.equal(files.get(path),`${b}|${a}||||`);
 send({type:'charmville:party-followers',speciesIds:[277],creatureIds:[a,b]});assert.equal(files.get(path),`${b}|${a}||||`);
 send({type:'charmville:party-followers',speciesIds:[277]});assert.equal(files.get(path),'|||||');
 send({type:'charmville:party-followers',speciesIds:[277],creatureIds:[a]});send({type:'charmville:follower',speciesId:0});assert.equal(files.get(path),'|||||');
});
