import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {stripWasmDebugBytes,stripWasmDebugFile} from './strip-wasm-debug.mjs';
const core=Buffer.from('0061736d010000000105016000017f03020100070a0106616e7377657200000a06010400412a0b','hex');
const custom=name=>{const n=Buffer.from(name),payload=Buffer.concat([Buffer.from([n.length]),n,Buffer.from([7,8,9])]);return Buffer.concat([Buffer.from([0,payload.length]),payload]);};
test('debug stripping preserves core execution and unrelated custom sections verbatim',async()=>{
 const keep=custom('producers'),input=Buffer.concat([core,custom('.debug_info'),keep,custom('name'),custom('.debug')]);
 const before=Buffer.from(input),{output,receipt}=stripWasmDebugBytes(input);
 assert.deepEqual(input,before);assert.deepEqual(output,Buffer.concat([core,keep,custom('.debug')]));
 assert.deepEqual(receipt.removed.map(x=>x.name),['.debug_info','name']);assert.equal(receipt.coreSectionsIdentical,true);assert.equal(receipt.acceptedRelease,false);
 const instance=await WebAssembly.instantiate(output);assert.equal(instance.instance.exports.answer(),42);
});
test('malformed framing, oversized ULEBs, invalid names and invalid core are rejected',()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.from('0061736d02000000','hex'),Buffer.concat([core,Buffer.from([0,128])]),Buffer.concat([core,Buffer.from([0,255,255,255,255,31])]),Buffer.concat([core,Buffer.from([0,9,1,65])]),Buffer.concat([core,Buffer.from([0,2,2,65])]),Buffer.concat([core,Buffer.from([0,2,1,255])]),Buffer.concat([core,Buffer.from([14,0])]),Buffer.concat([core,Buffer.from([1,0])])])assert.throws(()=>stripWasmDebugBytes(bytes));
});
test('file output is exclusive and input remains unchanged',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wasm-strip-'));try{const src=path.join(dir,'source.wasm'),dst=path.join(dir,'new.wasm');const input=Buffer.concat([core,custom('.debug_line')]);await writeFile(src,input);const receipt=await stripWasmDebugFile(src,dst);assert.deepEqual(await readFile(src),input);assert.deepEqual(await readFile(dst),core);assert.equal(receipt.outputBytes,core.length);await assert.rejects(stripWasmDebugFile(src,src));await assert.rejects(stripWasmDebugFile(src,dst));assert.deepEqual(await readFile(dst),core);}finally{await rm(dir,{recursive:true,force:true});}
});
