import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportPrivateRuntime} from './export-private-runtime.mjs';
import {adaptPrivateHtml,adaptPrivateMain,privateRuntimeConfig} from './private-runtime-adapter.mjs';
import {midiBankManifest} from './midi-bank.mjs';
import {stripWasmDebugBytes} from './strip-wasm-debug.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Assemble into a NEW directory. A candidate marker deliberately cannot pass
 * the serving gate: browser acceptance and release promotion remain separate. */
export async function assemblePrivateRuntime({input,output,release,accountOrigin,localMirror=false,relocateBridge,stripPlayerDebug=false}) {
  if(typeof stripPlayerDebug!=='boolean')throw Error('Debug stripping must be explicitly boolean');
  privateRuntimeConfig({release,accountOrigin,localMirror});
  if(typeof relocateBridge!=='function')throw Error('Reviewed bridge relocator required');
  const source=path.resolve(input),target=path.resolve(output);
  const receipt=JSON.parse(await readFile(path.join(source,'PACKAGE-COMPLETE.json'),'utf8'));
  const raw=await readFile(path.join(source,'inventory.json'),'utf8');
  if(receipt.kind!=='private-runtime-input-package'||receipt.readyToServe!==false||receipt.inventorySha256!==digest(raw))throw Error('Verified input package required');
  const inventory=JSON.parse(raw);
  const roots=Object.fromEntries(['repo','runtime','content','sprite'].map(key=>[key,path.join(source,key)]));
  await exportPrivateRuntime({manifest:inventory,roots,output:target});
  // The exporter marker remains input-only throughout a failed transformation.
  const files=inventory.files.map(entry=>({...entry}));
  const binaryTransform=stripPlayerDebug?await stripCandidatePlayerDebug(target,files):null;
  const options={release,accountOrigin,localMirror};
  async function transform(entry,fn) {
    const filename=path.join(target,entry.root,entry.path);
    const changed=await fn(await readFile(filename,'utf8'));
    await writeFile(filename,changed);
    entry.bytes=Buffer.byteLength(changed);entry.sha256=digest(changed);
  }
  for(const entry of files) {
    if(entry.role!=='served')continue;
    if(entry.route==='/play/')await transform(entry,source=>adaptPrivateHtml(source,options));
    else if(entry.route==='/main.js')await transform(entry,source=>adaptPrivateMain(source,options));
    else if(entry.root==='repo'&&entry.path.startsWith('scripts/charmville/'))await transform(entry,source=>relocateBridge(source,path.basename(entry.path),options));
    if(entry.route==='/sw.js'||entry.route.startsWith('/workbox-')||entry.route==='/manifest.json')entry.role='excluded-source';
  }
  async function generated(name,route,value) {
    const bytes=JSON.stringify(value)+'\n';
    await writeFile(path.join(target,'runtime',name),bytes,{flag:'wx'});
    files.push({root:'runtime',path:name,route,role:'served',bytes:Buffer.byteLength(bytes),sha256:digest(bytes),status:'present'});
  }
  const quest=JSON.parse(await readFile(path.join(target,'content','joined-homestead-metadata.json'),'utf8'));
  if(quest.id!=='quests/charmville/homestead-region'||quest.defaultPath!=='quests/charmville/homestead-region/r01/Homestead.qst')throw Error('Unexpected quest identity');
  await generated('private-quest-manifest.json','/reference-data/manifest.json',{[quest.id]:quest});
  await generated('private-midi-bank.json','/midi-bank.json',await midiBankManifest(path.join(target,'runtime','timidity')));
  const manifest={schemaVersion:1,scope:inventory.scope,completeInventory:true,files,issues:[],readiness:'transformed-candidate'};
  const encoded=JSON.stringify(manifest,null,2)+'\n';
  await writeFile(path.join(target,'inventory.json'),encoded);
  const result={schemaVersion:1,kind:'charmville-runtime-candidate',readyToServe:false,release,accountOrigin,
    inventorySha256:digest(encoded),files:files.length,servedFiles:files.filter(entry=>entry.role==='served').length,
    ...(binaryTransform?{binaryTransforms:[binaryTransform]}:{}),
    pending:['Authenticated cold-cache browser and worker acceptance','Inventory coverage against actual network requests','Reviewed release promotion']};
  await writeFile(path.join(target,'PACKAGE-COMPLETE.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}

/** Only called on the freshly exported candidate directory, never the source
 * or deploy staging path. Inventory identity changes before candidate hashing. */
export async function stripCandidatePlayerDebug(target,files) {
  const marker=JSON.parse(await readFile(path.join(target,'PACKAGE-COMPLETE.json'),'utf8'));
  if(marker.kind!=='private-runtime-input-package'||marker.readyToServe!==false)throw Error('Only unaccepted input-copy targets may be transformed');
  const matches=files.filter(e=>e.role==='served'&&e.route==='/zplayer.wasm');
  if(matches.length!==1||matches[0].root!=='runtime'||matches[0].path!=='zplayer.wasm')throw Error('Exactly one canonical player binary required');
  const entry=matches[0],filename=path.join(target,'runtime','zplayer.wasm');
  const original=await readFile(filename);
  if(original.length!==entry.bytes||digest(original)!==entry.sha256)throw Error('Candidate player identity mismatch');
  const {output,receipt}=stripWasmDebugBytes(original);
  await writeFile(filename,output);
  entry.bytes=output.length;entry.sha256=receipt.outputSha256;
  return {route:entry.route,...receipt};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  throw Error('Use the exported assembler with the reviewed bridge relocator; no implicit release promotion');
}
