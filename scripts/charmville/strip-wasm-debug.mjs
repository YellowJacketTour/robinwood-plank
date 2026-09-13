import {constants} from 'node:fs';
import {open,lstat,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const LIMIT=512*1024*1024, HEADER=Buffer.from('0061736d01000000','hex');
const digest=b=>createHash('sha256').update(b).digest('hex');
function parse(bytes){
 if(bytes.length<8||bytes.length>LIMIT||!bytes.subarray(0,8).equals(HEADER))throw Error('Expected bounded WebAssembly version 1 binary');
 let cursor=8;
 function leb(end){let result=0;for(let i=0;i<5;i++){if(cursor>=end)throw Error('Truncated ULEB32');const byte=bytes[cursor++];if(i===4&&(byte&0xf0))throw Error('Oversized ULEB32');result+=(byte&127)*2**(7*i);if(!(byte&128))return result;}throw Error('Oversized ULEB32');}
 const sections=[];
 while(cursor<bytes.length){const start=cursor,id=bytes[cursor++];if(id>13)throw Error('Unsupported section ID');const length=leb(bytes.length),end=cursor+length;if(end>bytes.length)throw Error('Truncated section');let name=null;
  if(id===0){const size=leb(end);if(size>end-cursor)throw Error('Truncated custom section name');name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(cursor,cursor+size));}
  sections.push({id,name,bytes:bytes.subarray(start,end)});cursor=end;
 }
 return sections;
}

/** Future build tool, not release acceptance. Retains all core and non-debug
 * custom sections byte-for-byte, including their original LEB encodings. */
export function stripWasmDebugBytes(input){
 const original=Buffer.from(input),sections=parse(original);
 if(!WebAssembly.validate(original))throw Error('Input WebAssembly validation failed');
 const removed=sections.filter(s=>s.id===0&&(s.name==='name'||/^\.debug_[A-Za-z0-9_]+$/.test(s.name)));
 const retained=sections.filter(s=>!removed.includes(s));
 const output=Buffer.concat([HEADER,...retained.map(s=>s.bytes)]);
 const parsed=parse(output);
 if(parsed.length!==retained.length||parsed.some((s,i)=>!s.bytes.equals(retained[i].bytes)))throw Error('Retained section identity mismatch');
 if(!WebAssembly.validate(output))throw Error('Output WebAssembly validation failed');
 const core=Buffer.concat(sections.filter(s=>s.id!==0).map(s=>s.bytes));
 const outputCore=Buffer.concat(parsed.filter(s=>s.id!==0).map(s=>s.bytes));
 if(!core.equals(outputCore))throw Error('Core section identity mismatch');
 return {output,receipt:{kind:'wasm-debug-strip-verification',acceptedRelease:false,inputBytes:original.length,outputBytes:output.length,removedBytes:original.length-output.length,inputSha256:digest(original),outputSha256:digest(output),coreSha256:digest(core),coreSectionsIdentical:true,retainedSectionsIdentical:true,inputValidated:true,outputValidated:true,removed:removed.map(s=>({name:s.name,bytes:s.bytes.length}))}};
}

export async function stripWasmDebugFile(input,output){
 if(path.resolve(input)===path.resolve(output))throw Error('A distinct new output file is required');
 const stat=await lstat(input);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw Error('Expected bounded ordinary input file');
 const handle=await open(input,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let result;
 try{const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw Error('Input changed');result=stripWasmDebugBytes(await handle.readFile());}finally{await handle.close();}
 const destination=await open(output,'wx',0o600);
 try{await destination.writeFile(result.output);await destination.sync();}catch(error){await destination.close();await unlink(output);throw error;}await destination.close();
 return result.receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==4){console.error('Usage: strip-wasm-debug.mjs <input.wasm> <new-output.wasm>');process.exitCode=1;}
 else stripWasmDebugFile(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
