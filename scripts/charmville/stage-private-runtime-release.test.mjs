import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {stagePrivateRuntimeRelease} from './stage-private-runtime-release.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
test('stager requires exact reviewed package and keeps artifacts outside public',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'charm-stage-'));
 try{
  const input=path.join(temp,'input'),standalone=path.join(temp,'standalone');await mkdir(input);await mkdir(standalone);
  for(const name of ['repo','runtime','content','sprite'])await mkdir(path.join(input,name));
  await writeFile(path.join(input,'runtime','a.wasm'),'fixture');
  const inventory={schemaVersion:1,scope:'joined-homestead-private-inventory',completeInventory:true,issues:[],files:[{root:'runtime',path:'a.wasm',route:'/a.wasm',role:'served',status:'present',bytes:7,sha256:hash('fixture')}]};
  const raw=JSON.stringify(inventory);await writeFile(path.join(input,'inventory.json'),raw);
  const receipt={kind:'charmville-runtime-release',release:'test',readyToServe:false,inventorySha256:hash(raw)};
  const options={input,standalone,release:'test',expectedInventorySha256:hash(raw)};
  await writeFile(path.join(input,'PACKAGE-COMPLETE.json'),JSON.stringify(receipt));
  await assert.rejects(stagePrivateRuntimeRelease(options),/candidates cannot/);
  receipt.readyToServe=true;await writeFile(path.join(input,'PACKAGE-COMPLETE.json'),JSON.stringify(receipt));
  await assert.rejects(stagePrivateRuntimeRelease({...options,expectedInventorySha256:'a'.repeat(64)}),/Reviewed/);
  const result=await stagePrivateRuntimeRelease(options);assert.equal(result.readyToDeploy,false);
  assert.equal(await readFile(path.join(standalone,'private/charmville/runtime/inventory.json'),'utf8'),raw);
  assert.equal(await readFile(path.join(standalone,'private/charmville/runtime/runtime/a.wasm'),'utf8'),'fixture');
 }finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert.ok(path.basename(temp).startsWith('charm-stage-'));await rm(temp,{recursive:true,force:true});}
});
