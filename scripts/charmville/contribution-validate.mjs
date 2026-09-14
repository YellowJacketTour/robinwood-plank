import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePack} from './pack-validate.mjs';

export const CONTRIBUTION_MAX_BYTES=32768;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=/^[a-f0-9]{64}$/,id=/^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9.-]{0,79}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const relative=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix+'/')&&/^[a-zA-Z0-9_./-]+$/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
function decode(bytes,limit){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>limit)throw Error('Manifest exceeds byte limit');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Manifest must be UTF-8 JSON');}
}
/** A proposed change envelope only. No scripts, imports, URLs, capabilities,
 * approval flags or economic commands can be represented by this schema. */
export function parseContributionManifest(bytes){
 const p=decode(bytes,CONTRIBUTION_MAX_BYTES);
 if(!exact(p,['schemaVersion','id','baseCommit','summary','packs','evidence'])||p.schemaVersion!==1||!id.test(p.id)||!/^([a-f0-9]{40})$/.test(p.baseCommit)||!text(p.summary,500))throw Error('Invalid contribution identity or fields');
 if(!Array.isArray(p.packs)||p.packs.length<1||p.packs.length>16)throw Error('Choose 1 to 16 pinned packs');
 const ids=new Set();
 for(const pack of p.packs){
  if(!exact(pack,['id','version','manifestSha256'])||!id.test(pack.id)||!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(pack.version)||!sha.test(pack.manifestSha256)||ids.has(pack.id))throw Error('Invalid or duplicate pack pin');
  ids.add(pack.id);Object.freeze(pack);
 }
 if(!Array.isArray(p.evidence)||p.evidence.length>32)throw Error('Evidence limit exceeded');
 const paths=new Set();
 for(const entry of p.evidence){
  if(!exact(entry,['kind','path','sha256'])||!['visual','rights','compatibility'].includes(entry.kind)||!relative(entry.path,'evidence')||! /\.(png|json|md)$/.test(entry.path)||!sha.test(entry.sha256)||paths.has(entry.path))throw Error('Invalid or duplicate evidence reference');
  paths.add(entry.path);Object.freeze(entry);
 }
 Object.freeze(p.packs);Object.freeze(p.evidence);return Object.freeze(p);
}

/** Resolve supplied bytes, never fetch contributor-controlled URLs or execute
 * repository hooks. This does not decode assets or approve content rights. */
export function verifyContributionPacks(contribution,manifests){
 // Revalidate even callers that did not use parseContributionManifest.
 const p=parseContributionManifest(Buffer.from(JSON.stringify(contribution)));
 const errors=[];
 for(const pin of p.packs){
  const bytes=manifests.get(pin.manifestSha256);
  if(!(bytes instanceof Uint8Array)){errors.push(`${pin.id}: missing pinned manifest`);continue;}
  if(bytes.byteLength>262144){errors.push(`${pin.id}: pack manifest exceeds byte limit`);continue;}
  if(hash(bytes)!==pin.manifestSha256){errors.push(`${pin.id}: manifest hash mismatch`);continue;}
  try {
   const pack=decode(bytes,262144);
   if(pack.id!==pin.id||pack.version!==pin.version)errors.push(`${pin.id}: manifest identity mismatch`);
   errors.push(...validatePack(pack).map(error=>`${pin.id}: ${error}`));
  }catch{errors.push(`${pin.id}: invalid pack manifest`);}
 }
 return errors;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try {
  if(process.argv.length!==3)throw Error('Usage: node contribution-validate.mjs proposal.json');
  const file=await open(process.argv[2],'r');let bytes;
  try {
   if(!(await file.stat()).isFile())throw Error('Proposal must be a regular file');
   const buffer=Buffer.alloc(CONTRIBUTION_MAX_BYTES+1);let length=0;
   while(length<buffer.length){const read=await file.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
   bytes=buffer.subarray(0,length);
  }finally{await file.close();}
  const proposal=parseContributionManifest(bytes);
  console.log(JSON.stringify({status:'validated-proposal',id:proposal.id,manifestSha256:hash(bytes),packCount:proposal.packs.length,publicationApproved:false}));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
