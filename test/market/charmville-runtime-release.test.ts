import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readRuntimeRelease} from '../../lib/charmville/runtime-release';

test('serving gate rejects input exports, wrong releases and changed inventory',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'charm-runtime-release-'));
  try {
    const inventory=JSON.stringify({schemaVersion:1,files:[]});
    const inventorySha256=createHash('sha256').update(inventory).digest('hex');
    await writeFile(path.join(root,'inventory.json'),inventory);
    const marker=path.join(root,'PACKAGE-COMPLETE.json');
    await writeFile(marker,JSON.stringify({kind:'private-runtime-input-package',readyToServe:false,release:'alpha01',inventorySha256}));
    await assert.rejects(readRuntimeRelease(root,'alpha01'));
    await writeFile(marker,JSON.stringify({kind:'charmville-runtime-release',readyToServe:true,release:'alpha01',inventorySha256}));
    await assert.rejects(readRuntimeRelease(root,'another'));
    assert.equal((await readRuntimeRelease(root,'alpha01')).roots.runtime,path.join(root,'runtime'));
    await writeFile(path.join(root,'inventory.json'),inventory+' ');
    await assert.rejects(readRuntimeRelease(root,'alpha01'));
    await assert.rejects(readRuntimeRelease(root,'../alpha01'));
  } finally {await rm(root,{recursive:true,force:true});}
});

test('local mirror candidates require explicit opt-in and the exact isolated origin',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'charm-runtime-candidate-'));
  try {
    const inventory=JSON.stringify({schemaVersion:1,files:[]});
    const inventorySha256=createHash('sha256').update(inventory).digest('hex');
    await writeFile(path.join(root,'inventory.json'),inventory);
    const marker=path.join(root,'PACKAGE-COMPLETE.json');
    const candidate={kind:'charmville-runtime-candidate',readyToServe:false,release:'alpha01-local',inventorySha256,accountOrigin:'http://localhost:3018'};
    await writeFile(marker,JSON.stringify(candidate));
    await assert.rejects(readRuntimeRelease(root,candidate.release));
    assert.equal((await readRuntimeRelease(root,candidate.release,{localCandidate:true})).configuredRelease,candidate.release);
    for(const accountOrigin of ['https://plank.love','http://localhost:3017','http://localhost:3018.evil.test']) {
      await writeFile(marker,JSON.stringify({...candidate,accountOrigin}));
      await assert.rejects(readRuntimeRelease(root,candidate.release,{localCandidate:true}));
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
