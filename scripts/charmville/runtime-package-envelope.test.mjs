import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,readdir,rm} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {encryptRuntimePackage,decryptRuntimePackage} from './runtime-package-envelope.mjs';
test('envelope authenticates both header and ciphertext, quarantines failed plaintext and never overwrites',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'charm-envelope-test-'));
 try{
  const input=path.join(temp,'input.zip'),sealed=path.join(temp,'sealed.bin'),output=path.join(temp,'output.zip');
  const key=randomBytes(32).toString('base64');await writeFile(input,'private fixture archive');
  const receipt=await encryptRuntimePackage({input,output:sealed,key});
  const again=path.join(temp,'second.bin');await encryptRuntimePackage({input,output:again,key});assert.notDeepEqual(await readFile(sealed),await readFile(again));
  const options={input:sealed,output,key,...receipt};const result=await decryptRuntimePackage(options);assert.equal(result.authenticated,true);assert.equal(await readFile(output,'utf8'),'private fixture archive');
  await assert.rejects(decryptRuntimePackage(options),{code:'EEXIST'});
  const rejected=path.join(temp,'rejected.zip');await assert.rejects(decryptRuntimePackage({...options,output:rejected,key:randomBytes(32).toString('base64')}));await assert.rejects(access(rejected),{code:'ENOENT'});
  for(const offset of [8,21,40]){
   const tampered=Buffer.from(await readFile(sealed));tampered[offset]^=1;const changed=path.join(temp,'tampered-'+offset);await writeFile(changed,tampered);
   // Re-pin outer hash to prove AEAD, not only SHA, rejects the altered envelope.
   await assert.rejects(decryptRuntimePackage({...options,input:changed,output:rejected,archiveSha256:createHash('sha256').update(tampered).digest('hex')}));
   await assert.rejects(access(rejected),{code:'ENOENT'});
  }
  assert.equal((await readdir(temp)).some(name=>name.startsWith('.charm-envelope-')),false);
  await assert.rejects(decryptRuntimePackage({...options,output:path.join(temp,'public','file.zip')}),/public/);
 }finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert.ok(path.basename(temp).startsWith('charm-envelope-test-'));await rm(temp,{recursive:true,force:true});}
});
