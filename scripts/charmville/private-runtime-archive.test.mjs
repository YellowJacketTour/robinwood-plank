import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';
import {packPrivateRuntime,extractPrivateRuntime} from './private-runtime-archive.mjs';
import {encryptRuntimePackage} from './runtime-package-envelope.mjs';
import {preparePrivateRuntimeRelease} from './prepare-private-runtime-release.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
test('streamed archive roundtrip and extraction rejects traversal, duplicate, excessive and corrupt content',async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'charm-archive-'));try{
  const input=path.join(temp,'input');await mkdir(path.join(input,'runtime'),{recursive:true});await writeFile(path.join(input,'runtime/a.wasm'),'fixture');
  const inventory={schemaVersion:1,scope:'joined-homestead-private-inventory',completeInventory:true,issues:[],files:[{root:'runtime',path:'a.wasm',route:'/a.wasm',role:'served',status:'present',bytes:7,sha256:sha('fixture')}]};
  const bytes=JSON.stringify(inventory),inventorySha256=sha(bytes);await writeFile(path.join(input,'inventory.json'),bytes);await writeFile(path.join(input,'PACKAGE-COMPLETE.json'),JSON.stringify({kind:'charmville-runtime-release',readyToServe:true,release:'test',inventorySha256}));
  const archive=path.join(temp,'runtime.cvgz');await packPrivateRuntime({input,output:archive,release:'test',inventorySha256});
  const output=path.join(temp,'output');await extractPrivateRuntime({input:archive,output,release:'test',inventorySha256});assert.equal(await readFile(path.join(output,'runtime/a.wasm'),'utf8'),'fixture');await access(path.join(output,'EXTRACTION-VERIFIED.json'));
  const key=Buffer.alloc(32,7).toString('base64'),sealed=path.join(temp,'sealed.bin'),standalone=path.join(temp,'standalone');await mkdir(standalone);
  const envelope=await encryptRuntimePackage({input:archive,output:sealed,key});
  const staged=await preparePrivateRuntimeRelease({input:sealed,workdir:path.join(temp,'prepare'),standalone,release:'test',inventorySha256,key,archiveSha256:envelope.archiveSha256,plaintextSha256:envelope.plaintextSha256});
  assert.equal(staged.readyToDeploy,false);assert.equal(await readFile(path.join(standalone,'private/charmville/runtime/runtime/a.wasm'),'utf8'),'fixture');
  await assert.rejects(extractPrivateRuntime({input:archive,output,release:'test',inventorySha256}),{code:'EEXIST'});
  const raw=gunzipSync(await readFile(archive)),length=raw.readUInt32BE(8),index=JSON.parse(raw.subarray(12,12+length).toString());
  const malicious=[{...index,files:[{...index.files[0],path:'runtime/../escape'},...index.files.slice(1)]},{...index,files:[...index.files,index.files[0]]},{...index,files:[{...index.files[0],bytes:900000001},...index.files.slice(1)]}];
  for(let i=0;i<malicious.length;i++){const json=Buffer.from(JSON.stringify(malicious[i])),size=Buffer.alloc(4);size.writeUInt32BE(json.length);const file=path.join(temp,'bad'+i);await writeFile(file,gzipSync(Buffer.concat([Buffer.from('CVARCH1\n'),size,json])));await assert.rejects(extractPrivateRuntime({input:file,output:path.join(temp,'badout'+i),release:'test',inventorySha256}));}
  const corrupt=Buffer.from(raw);corrupt[12+length]^=1;const file=path.join(temp,'corrupt');await writeFile(file,gzipSync(corrupt));await assert.rejects(extractPrivateRuntime({input:file,output:path.join(temp,'corruptout'),release:'test',inventorySha256}),/integrity/);await assert.rejects(access(path.join(temp,'corruptout','EXTRACTION-VERIFIED.json')),{code:'ENOENT'});
 }finally{assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert.ok(path.basename(temp).startsWith('charm-archive-'));await rm(temp,{recursive:true,force:true});}
});
