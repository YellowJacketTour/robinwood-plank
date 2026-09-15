import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePack} from './pack-validate.mjs';

import {CONTRIBUTION_MAX_BYTES, parseContributionManifest} from './contribution-schema.mjs';
export {CONTRIBUTION_MAX_BYTES, parseContributionManifest} from './contribution-schema.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function decode(bytes,limit){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>limit)throw Error('Manifest exceeds byte limit');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Manifest must be UTF-8 JSON');}
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
