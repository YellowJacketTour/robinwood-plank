import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,open} from 'node:fs/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const MAGIC=Buffer.from('CVARCH1\n'),MAX_BYTES=900_000_000,MAX_INDEX=2_000_000,MAX_FILES=4096;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function parts(value){
 if(typeof value!=='string'||/[\\:%\x00-\x20]/.test(value))throw Error('Unsafe archive path');
 const result=value.split('/');
 if(result.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw Error('Unsafe archive path');
 if(!['repo','runtime','content','sprite'].includes(result[0])&&!['inventory.json','PACKAGE-COMPLETE.json'].includes(value))throw Error('Unexpected archive root');
 return result;
}
async function noLinks(filename){
 const absolute=path.resolve(filename);let cursor=path.parse(absolute).root;
 for(const part of absolute.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw Error('Archive paths cannot use symbolic links');}
}
function checkIndex(index){
 if(index?.version!==1||!Array.isArray(index.files)||index.files.length<2||index.files.length>MAX_FILES)throw Error('Invalid archive index');
 let total=0;const seen=new Set();
 for(const file of index.files){parts(file.path);const lower=file.path.toLowerCase();if(seen.has(lower))throw Error('Duplicate archive path');seen.add(lower);
  if(!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid archive file');total+=file.bytes;if(total>MAX_BYTES)throw Error('Archive expansion limit');}
 if(!seen.has('inventory.json')||!seen.has('package-complete.json'))throw Error('Package metadata missing');
 return total;
}
async function packageMetadata(root,release,expectedInventorySha256){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release)||!/^[a-f0-9]{64}$/.test(expectedInventorySha256))throw Error('Pinned release/inventory required');
 async function small(name){const filename=path.join(root,name);await noLinks(filename);const info=await lstat(filename);if(!info.isFile()||info.size>MAX_INDEX)throw Error('Invalid metadata');return readFile(filename);}
 const inventoryBytes=await small('inventory.json'),receiptBytes=await small('PACKAGE-COMPLETE.json');
 const receipt=JSON.parse(receiptBytes.toString('utf8')),inventory=JSON.parse(inventoryBytes.toString('utf8'));
 if(hash(inventoryBytes)!==expectedInventorySha256||receipt.inventorySha256!==expectedInventorySha256||receipt.kind!=='charmville-runtime-release'||receipt.readyToServe!==true||receipt.release!==release)throw Error('Accepted package required');
 if(inventory.schemaVersion!==1||inventory.scope!=='joined-homestead-private-inventory'||inventory.completeInventory!==true||!Array.isArray(inventory.files)||!Array.isArray(inventory.issues)||inventory.issues.length)throw Error('Complete inventory required');
 const files=inventory.files.map(file=>{if(file.status!=='present'||!['repo','runtime','content','sprite'].includes(file.root))throw Error('Invalid inventory entry');return{path:file.root+'/'+file.path,bytes:file.bytes,sha256:file.sha256};});
 files.push({path:'inventory.json',bytes:inventoryBytes.length,sha256:hash(inventoryBytes)},{path:'PACKAGE-COMPLETE.json',bytes:receiptBytes.length,sha256:hash(receiptBytes)});
 const index={version:1,files};checkIndex(index);return index;
}
export async function packPrivateRuntime({input,output,release,inventorySha256}){
 const root=path.resolve(input);await noLinks(root);await noLinks(path.dirname(path.resolve(output)));
 const index=await packageMetadata(root,release,inventorySha256);const json=Buffer.from(JSON.stringify(index));if(json.length>MAX_INDEX)throw Error('Index too large');
 const length=Buffer.alloc(4);length.writeUInt32BE(json.length);
 async function* source(){
  yield MAGIC;yield length;yield json;
  for(const entry of index.files){const filename=path.join(root,...parts(entry.path));await noLinks(filename);const info=await lstat(filename);if(!info.isFile()||info.size!==entry.bytes)throw Error('Changed source file');const digest=createHash('sha256');let count=0;
   for await(const chunk of createReadStream(filename)){count+=chunk.length;if(count>entry.bytes)throw Error('Changed source size');digest.update(chunk);yield chunk;}
   if(count!==entry.bytes||digest.digest('hex')!==entry.sha256)throw Error('Changed source hash');}
 }
 await pipeline(Readable.from(source()),createGzip({level:6}),createWriteStream(output,{flags:'wx',mode:0o600}));
 return{format:'CVARCH1+gzip',files:index.files.length,totalBytes:checkIndex(index),readyToServe:false};
}
class Reader{
 constructor(stream){this.iterator=stream[Symbol.asyncIterator]();this.buffer=Buffer.alloc(0);this.offset=0;}
 async next(max){while(this.offset===this.buffer.length){const result=await this.iterator.next();if(result.done)return null;this.buffer=Buffer.from(result.value);this.offset=0;}const size=Math.min(max,this.buffer.length-this.offset);const bytes=this.buffer.subarray(this.offset,this.offset+size);this.offset+=size;return bytes;}
 async exact(size){const chunks=[];let remaining=size;while(remaining){const bytes=await this.next(remaining);if(!bytes)throw Error('Truncated archive');chunks.push(bytes);remaining-=bytes.length;}return Buffer.concat(chunks,size);}
}
export async function extractPrivateRuntime({input,output,release,inventorySha256}){
 const root=path.resolve(output);if(root.split(path.sep).some(part=>part.toLowerCase()==='public'))throw Error('Private output required');await noLinks(path.dirname(root));await noLinks(path.resolve(input));
 const info=await lstat(input);if(!info.isFile()||info.size>MAX_BYTES)throw Error('Archive input too large');
 await mkdir(root);const source=createReadStream(input),decoder=createGunzip();source.on('error',error=>decoder.destroy(error));source.pipe(decoder);const reader=new Reader(decoder);
 try{
  if(!(await reader.exact(8)).equals(MAGIC))throw Error('Unsupported archive');const indexSize=(await reader.exact(4)).readUInt32BE();if(indexSize<2||indexSize>MAX_INDEX)throw Error('Index size limit');
  const index=JSON.parse((await reader.exact(indexSize)).toString('utf8'));const totalBytes=checkIndex(index);
  for(const name of ['repo','runtime','content','sprite'])await mkdir(path.join(root,name));
  for(const entry of index.files){const filename=path.join(root,...parts(entry.path));await mkdir(path.dirname(filename),{recursive:true});await noLinks(path.dirname(filename));const handle=await open(filename,'wx',0o600);const digest=createHash('sha256');let remaining=entry.bytes;
   try{while(remaining){const chunk=await reader.next(Math.min(remaining,65536));if(!chunk)throw Error('Truncated file');digest.update(chunk);let offset=0;while(offset<chunk.length){const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw Error('Failed archive write');offset+=written.bytesWritten;}remaining-=chunk.length;}}finally{await handle.close();}
   if(digest.digest('hex')!==entry.sha256)throw Error('Archive file integrity failure');}
  if(await reader.next(1))throw Error('Trailing archive bytes');
  const expected=await packageMetadata(root,release,inventorySha256);
  if(JSON.stringify(expected.files)!==JSON.stringify(index.files))throw Error('Archive/index inventory mismatch');
  await writeFile(path.join(root,'EXTRACTION-VERIFIED.json'),JSON.stringify({format:'CVARCH1+gzip',release,inventorySha256,files:index.files.length,totalBytes})+'\n',{flag:'wx',mode:0o600});
  return{format:'CVARCH1+gzip',files:index.files.length,totalBytes,authenticatedInventory:true,readyToServe:false};
 }finally{source.destroy();decoder.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={},allowed=new Set(['mode','input','output','release','inventory-sha256']);
 for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2),value=process.argv[i+1];if(!process.argv[i].startsWith('--')||!allowed.has(key)||args[key]||!value||value.startsWith('--'))throw Error('Invalid archive arguments');args[key]=value;}
 try{const operation=args.mode==='pack'?packPrivateRuntime:args.mode==='extract'?extractPrivateRuntime:null;if(!operation)throw Error('Expected pack or extract');console.log(JSON.stringify(await operation({input:args.input,output:args.output,release:args.release,inventorySha256:args['inventory-sha256']})));}
 catch{console.error('Private runtime archive failed; output must not be staged without extraction verification.');process.exitCode=1;}
}
