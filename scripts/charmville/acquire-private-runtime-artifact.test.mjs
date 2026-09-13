import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquirePrivateRuntimeArtifact} from './acquire-private-runtime-artifact.mjs';
test('acquisition requires private pinned artifact and drops credential at storage boundary',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'charm-acquire-'));
 try{
  const data='zipfixture',sha=createHash('sha256').update(data).digest('hex');
  const options={repository:'owner/private-vault',artifactId:'123',artifactName:'charmville-runtime-alpha',headSha:'a'.repeat(40),archiveSha256:sha,output:path.join(temp,'runtime.zip')};
  let privateRepo=true,badHead=false,storageBody=data;
  const fetchImpl=async(url,init)=>{
   if(url.startsWith('https://api.github.com/'))assert.equal(init.headers.authorization,'Bearer test-only');
   if(url.endsWith('/private-vault'))return Response.json({private:privateRepo,full_name:options.repository});
   if(url.endsWith('/123'))return Response.json({id:123,name:options.artifactName,expired:false,size_in_bytes:10,workflow_run:{head_sha:badHead?'b'.repeat(40):options.headSha}});
   if(url.endsWith('/zip'))return new Response(null,{status:302,headers:{location:'https://objects.githubusercontent.com/private.zip?signature=test'}});
   assert.equal(init.headers,undefined);return new Response(storageBody);
  };
  privateRepo=false;await assert.rejects(acquirePrivateRuntimeArtifact(options,{token:'test-only',fetchImpl}),/private repository/);
  privateRepo=true;badHead=true;await assert.rejects(acquirePrivateRuntimeArtifact(options,{token:'test-only',fetchImpl}),/identity/);
  badHead=false;const result=await acquirePrivateRuntimeArtifact(options,{token:'test-only',fetchImpl});assert.equal(result.readyToServe,false);
  assert.equal(await readFile(options.output,'utf8'),data);
  const marker=await readFile(options.output+'.verified.json','utf8');assert.ok(!marker.includes('test-only'));assert.ok(!marker.includes('signature='));
  storageBody='corrupted';const bad={...options,output:path.join(temp,'bad.zip')};await assert.rejects(acquirePrivateRuntimeArtifact(bad,{token:'test-only',fetchImpl}),/hash mismatch/);
  await assert.rejects(access(bad.output+'.verified.json'),{code:'ENOENT'});
 }finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert.ok(path.basename(temp).startsWith('charm-acquire-'));await rm(temp,{recursive:true,force:true});}
});
