import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stripCandidatePlayerDebug,assemblePrivateRuntime} from './assemble-private-runtime.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const core=Buffer.from('0061736d01000000','hex'),debug=Buffer.from([0,7,4,110,97,109,101,0,0]);
test('opt-in transform updates inventory hash and returns retained core evidence',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'candidate-debug-'));try{
 await mkdir(path.join(root,'runtime'));await writeFile(path.join(root,'PACKAGE-COMPLETE.json'),JSON.stringify({kind:'private-runtime-input-package',readyToServe:false}));
 const input=Buffer.concat([core,debug]),file=path.join(root,'runtime/zplayer.wasm');await writeFile(file,input);
 const files=[{role:'served',route:'/zplayer.wasm',root:'runtime',path:'zplayer.wasm',bytes:input.length,sha256:hash(input)}];
 const receipt=await stripCandidatePlayerDebug(root,files);assert.deepEqual(await readFile(file),core);assert.equal(files[0].sha256,hash(core));assert.equal(files[0].bytes,8);assert.equal(receipt.inputSha256,hash(input));assert.equal(receipt.coreSectionsIdentical,true);
 await assert.rejects(stripCandidatePlayerDebug(root,[]));await assert.rejects(stripCandidatePlayerDebug(root,[files[0],files[0]]));
 files[0].sha256='0'.repeat(64);await assert.rejects(stripCandidatePlayerDebug(root,files));assert.deepEqual(await readFile(file),core);
 await writeFile(path.join(root,'PACKAGE-COMPLETE.json'),JSON.stringify({kind:'charmville-runtime-release',readyToServe:true}));await assert.rejects(stripCandidatePlayerDebug(root,files));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('nonboolean stripping options fail before filesystem or assembly changes',async()=>{
 for(const option of ['true',1,null])await assert.rejects(assemblePrivateRuntime({stripPlayerDebug:option}),/explicitly boolean/);
});
