import {createReadStream,createWriteStream} from 'node:fs';
import {lstat,open,writeFile,link,unlink} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const MAGIC=Buffer.from('CVPKG01\n'),MAX=1_000_000_000;
function keyBytes(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw Error('A base64 32-byte package key is required');
 const key=Buffer.from(value,'base64');if(key.length!==32||key.toString('base64')!==value)throw Error('Invalid package key');return key;
}
async function regular(file){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>MAX)throw Error('Invalid archive file');return info;}
async function sha(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function target(output,privateOutput){
 const absolute=path.resolve(output),parent=path.dirname(absolute);
 if(privateOutput&&absolute.split(path.sep).some(x=>x.toLowerCase()==='public'))throw Error('Plaintext cannot be placed under public');
 let cursor=path.parse(parent).root;
 for(const part of parent.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe output directory');}
 return {absolute,temp:path.join(parent,'.charm-envelope-'+randomBytes(12).toString('hex'))};
}
async function publish(temp,absolute){await link(temp,absolute);await unlink(temp);}
export async function encryptRuntimePackage({input,output,key}){
 const secret=keyBytes(key);await regular(input);const dest=await target(output,false);
 const nonce=randomBytes(12),header=Buffer.concat([MAGIC,nonce]);
 const cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(header);
 try{
  await writeFile(dest.temp,header,{flag:'wx',mode:0o600});
  await pipeline(createReadStream(input),cipher,createWriteStream(dest.temp,{flags:'a',mode:0o600}));
  const handle=await open(dest.temp,'a');try{await handle.write(cipher.getAuthTag());}finally{await handle.close();}
  const receipt={format:'CVPKG01',algorithm:'AES-256-GCM',archiveSha256:await sha(dest.temp),plaintextSha256:await sha(input),bytes:(await lstat(dest.temp)).size};
  await publish(dest.temp,dest.absolute);return receipt;
 }catch(error){await unlink(dest.temp).catch(()=>{});throw error;}finally{secret.fill(0);}
}
export async function decryptRuntimePackage({input,output,key,archiveSha256,plaintextSha256}){
 if(!/^[a-f0-9]{64}$/.test(archiveSha256)||!/^[a-f0-9]{64}$/.test(plaintextSha256))throw Error('Independently pinned archive and plaintext hashes required');
 const info=await regular(input);if(info.size<37)throw Error('Truncated envelope');
 if(await sha(input)!==archiveSha256)throw Error('Ciphertext hash mismatch');
 const secret=keyBytes(key),dest=await target(output,true);const handle=await open(input,'r');
 const header=Buffer.alloc(20),tag=Buffer.alloc(16);
 try{await handle.read(header,0,20,0);await handle.read(tag,0,16,info.size-16);}finally{await handle.close();}
 if(!header.subarray(0,8).equals(MAGIC)){secret.fill(0);throw Error('Unknown envelope');}
 const decipher=createDecipheriv('aes-256-gcm',secret,header.subarray(8));decipher.setAAD(header);decipher.setAuthTag(tag);
 try{
  await pipeline(createReadStream(input,{start:20,end:info.size-17}),decipher,createWriteStream(dest.temp,{flags:'wx',mode:0o600}));
  if(await sha(dest.temp)!==plaintextSha256)throw Error('Plaintext hash mismatch');
  await publish(dest.temp,dest.absolute);return {format:'CVPKG01',archiveSha256,plaintextSha256,authenticated:true,readyToServe:false};
 }catch(error){await unlink(dest.temp).catch(()=>{});throw error;}finally{secret.fill(0);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={};const flags=new Set(['mode','input','output','archive-sha256','plaintext-sha256']);
 for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2),value=process.argv[i+1];if(!process.argv[i].startsWith('--')||!flags.has(key)||args[key]||!value||value.startsWith('--'))throw Error('Invalid envelope arguments');args[key]=value;}
 try{
  const options={input:args.input,output:args.output,key:process.env.CHARMVILLE_RUNTIME_PACKAGE_KEY,archiveSha256:args['archive-sha256'],plaintextSha256:args['plaintext-sha256']};
  const operation=args.mode==='encrypt'?encryptRuntimePackage:args.mode==='decrypt'?decryptRuntimePackage:null;if(!operation)throw Error('Expected encrypt or decrypt');
  console.log(JSON.stringify(await operation(options)));
 }catch{console.error('Runtime envelope operation failed; no output was authenticated for serving.');process.exitCode=1;}
}
