import {readFile,writeFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportPrivateRuntime} from './export-private-runtime.mjs';
import {PRIVATE_BRIDGE_HASHES} from './private-runtime-bridges.mjs';
import {privateRuntimeConfig} from './private-runtime-adapter.mjs';

export const REQUIRED_BROWSER_CHECKS=Object.freeze(['coldStart','movement','farmingHarvest','reloadPersistence','socialPin','ticketRenewal','unauthorizedDenied','revokedDenied']);
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fileHash(filename){const digest=createHash('sha256');for await(const bytes of createReadStream(filename))digest.update(bytes);return digest.digest('hex');}
async function noLinks(filename){let cursor=path.parse(filename).root;for(const part of filename.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw Error('Linked candidate input');}}
async function smallFile(filename){await noLinks(filename);const info=await lstat(filename);if(!info.isFile()||info.size>2_000_000)throw Error('Invalid candidate metadata');return readFile(filename,'utf8');}
function entryPath(root,entry){
 if(!['repo','runtime','content','sprite'].includes(entry.root)||typeof entry.path!=='string'||/[\\:%\x00-\x20]/.test(entry.path)||entry.path.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Unsafe candidate path');
 return path.join(root,entry.root,...entry.path.split('/'));
}
async function candidate(root){
 const absolute=path.resolve(root),receipt=JSON.parse(await smallFile(path.join(absolute,'PACKAGE-COMPLETE.json'))),raw=await smallFile(path.join(absolute,'inventory.json'));
 if(receipt.kind!=='charmville-runtime-candidate'||receipt.readyToServe!==false||receipt.inventorySha256!==hash(raw))throw Error('Verified candidate required');
 const inventory=JSON.parse(raw);if(inventory.schemaVersion!==1||inventory.scope!=='joined-homestead-private-inventory'||inventory.completeInventory!==true||!Array.isArray(inventory.files)||!Array.isArray(inventory.issues)||inventory.issues.length)throw Error('Incomplete candidate inventory');
 const files=new Map();for(const entry of inventory.files){const key=entry.root+'/'+entry.path;if(files.has(key.toLowerCase())||entry.status!=='present'||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid candidate entry');const filename=entryPath(absolute,entry);await noLinks(filename);const info=await lstat(filename);if(!info.isFile()||info.size!==entry.bytes||await fileHash(filename)!==entry.sha256)throw Error('Candidate bytes changed');files.set(key.toLowerCase(),entry);}
 return{absolute,receipt,raw,inventory,files};
}
function normalizeText(source,config){return source.split(config.accountOrigin).join('__ACCOUNT_ORIGIN__').split(config.prefix).join('__RUNTIME_PREFIX__');}
/** Evidence is an explicit operator review record, not auto-generated acceptance.
 * Both candidates are rehashed and compared before copying to a new directory.
 */
export async function promotePrivateRuntime({mirror,target,acceptance,output}){
 const evidenceRaw=await smallFile(path.resolve(acceptance)),evidence=JSON.parse(evidenceRaw);
 if(evidence.schemaVersion!==1||evidence.kind!=='charmville-runtime-browser-acceptance'||typeof evidence.reviewedBy!=='string'||!evidence.reviewedBy.trim()||!Number.isFinite(Date.parse(evidence.reviewedAt))||!Array.isArray(evidence.artifacts)||!evidence.artifacts.length||evidence.artifacts.some(x=>typeof x!=='string'||!x.trim())||REQUIRED_BROWSER_CHECKS.some(key=>evidence.checks?.[key]!==true))throw Error('Complete explicit browser acceptance required');
 const local=await candidate(mirror),remote=await candidate(target);
 if(evidence.localTestedInventorySha256!==local.receipt.inventorySha256||evidence.targetInventorySha256!==remote.receipt.inventorySha256)throw Error('Acceptance is for different candidate bytes');
 if(local.receipt.accountOrigin!=='http://localhost:3018')throw Error('Unexpected mirror origin');
 const localConfig=privateRuntimeConfig({release:local.receipt.release,accountOrigin:local.receipt.accountOrigin,localMirror:true});
 const targetConfig=privateRuntimeConfig({release:remote.receipt.release,accountOrigin:remote.receipt.accountOrigin});
 if(local.files.size!==remote.files.size)throw Error('Candidate file sets differ');
 const textFiles=new Set(['runtime/play/index.html','runtime/main.js',...Object.keys(PRIVATE_BRIDGE_HASHES).map(name=>'repo/scripts/charmville/'+name)]);
 for(const [key,entry]of local.files){const other=remote.files.get(key);if(!other||entry.root!==other.root||entry.path!==other.path||entry.role!==other.role||entry.route!==other.route)throw Error('Candidate topology differs');if(entry.sha256===other.sha256)continue;
  if(!textFiles.has(key))throw Error('Candidate binaries/content differ');
  const left=await smallFile(entryPath(local.absolute,entry)),right=await smallFile(entryPath(remote.absolute,other));
  if(normalizeText(left,localConfig)!==normalizeText(right,targetConfig))throw Error('Candidate differences exceed origin/release relocation');
 }
 const roots=Object.fromEntries(['repo','runtime','content','sprite'].map(name=>[name,path.join(remote.absolute,name)]));
 await exportPrivateRuntime({manifest:remote.inventory,roots,output});
 const destination=path.resolve(output);await writeFile(path.join(destination,'inventory.json'),remote.raw);
 await writeFile(path.join(destination,'BROWSER-ACCEPTANCE.json'),evidenceRaw,{flag:'wx'});
 const receipt={schemaVersion:1,kind:'charmville-runtime-release',readyToServe:true,release:remote.receipt.release,accountOrigin:remote.receipt.accountOrigin,inventorySha256:remote.receipt.inventorySha256,localTestedInventorySha256:local.receipt.inventorySha256,acceptanceSha256:hash(evidenceRaw),reviewedBy:evidence.reviewedBy,reviewedAt:evidence.reviewedAt,browserAcceptance:evidence};
 // Last write is the only accepted marker. Source candidates remain unchanged.
 await writeFile(path.join(destination,'PACKAGE-COMPLETE.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={},allowed=new Set(['mirror','target','acceptance','output']);
 for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2),value=process.argv[i+1];if(!process.argv[i].startsWith('--')||!allowed.has(key)||args[key]||!value||value.startsWith('--'))throw Error('Invalid promotion arguments');args[key]=value;}
 for(const key of allowed)if(!args[key])throw Error(`Missing --${key}`);
 try{console.log(JSON.stringify(await promotePrivateRuntime(args)));}catch{console.error('Candidate promotion refused; explicit matching acceptance and identical content are required.');process.exitCode=1;}
}

