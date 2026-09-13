import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {promotePrivateRuntime,REQUIRED_BROWSER_CHECKS} from './promote-private-runtime.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('promotion requires pinned reviewed evidence and only origin/release differences',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'charm-promote-'));
 try{
  async function candidate(name,origin,release,body){
   const root=path.join(temp,name);for(const dir of ['repo','runtime','content','sprite'])await mkdir(path.join(root,dir),{recursive:true});
   const source=body??`const origin='${origin}'; const prefix='/charmville/runtime/${release}/';`;
   await writeFile(path.join(root,'runtime/main.js'),source);
   const raw=JSON.stringify({schemaVersion:1,scope:'joined-homestead-private-inventory',completeInventory:true,issues:[],files:[{root:'runtime',path:'main.js',route:'/main.js',role:'served',status:'present',bytes:Buffer.byteLength(source),sha256:hash(source)}]});
   await writeFile(path.join(root,'inventory.json'),raw);
   await writeFile(path.join(root,'PACKAGE-COMPLETE.json'),JSON.stringify({kind:'charmville-runtime-candidate',readyToServe:false,release,accountOrigin:origin,inventorySha256:hash(raw)}));return {root,sha:hash(raw)};
  }
  const local=await candidate('local','http://localhost:3018','alpha-local'),remote=await candidate('remote','https://plank.love','alpha-01');
  const evidence={schemaVersion:1,kind:'charmville-runtime-browser-acceptance',reviewedBy:'test fixture',reviewedAt:'2026-09-13T00:00:00Z',artifacts:['synthetic-only'],localTestedInventorySha256:local.sha,targetInventorySha256:remote.sha,checks:Object.fromEntries(REQUIRED_BROWSER_CHECKS.map(x=>[x,true]))};
  const acceptance=path.join(temp,'acceptance.json');await writeFile(acceptance,JSON.stringify(evidence));
  const result=await promotePrivateRuntime({mirror:local.root,target:remote.root,acceptance,output:path.join(temp,'accepted')});
  assert.equal(result.readyToServe,true);assert.deepEqual(result.browserAcceptance,evidence);
  assert.equal(JSON.parse(await readFile(path.join(remote.root,'PACKAGE-COMPLETE.json'))).readyToServe,false);
  await writeFile(acceptance,JSON.stringify({...evidence,checks:{...evidence.checks,socialPin:false}}));
  await assert.rejects(promotePrivateRuntime({mirror:local.root,target:remote.root,acceptance,output:path.join(temp,'bad')}),/acceptance/);
  const different=await candidate('different','https://plank.love','alpha-01','arbitrary changed behavior');
  await writeFile(acceptance,JSON.stringify({...evidence,targetInventorySha256:different.sha}));
  await assert.rejects(promotePrivateRuntime({mirror:local.root,target:different.root,acceptance,output:path.join(temp,'different-output')}),/differences/);
  await writeFile(acceptance,JSON.stringify(evidence));await writeFile(path.join(remote.root,'runtime/main.js'),'tampered');
  await assert.rejects(promotePrivateRuntime({mirror:local.root,target:remote.root,acceptance,output:path.join(temp,'tampered')}),/bytes changed/);
 }finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert.ok(path.basename(temp).startsWith('charm-promote-'));await rm(temp,{recursive:true,force:true});}
});
