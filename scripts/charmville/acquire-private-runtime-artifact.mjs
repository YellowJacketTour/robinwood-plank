import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { writeFile, lstat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateArtifactRequest(value) {
  const {repository,artifactId,artifactName,headSha,archiveSha256,output}=value;
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||repository.split('/').some(x=>x==='.'||x==='..'))throw Error('Invalid repository');
  if(!/^[1-9]\d{0,18}$/.test(String(artifactId))||!/^charmville-runtime-[A-Za-z0-9_-]{1,96}$/.test(artifactName)||!/^[a-f0-9]{40}$/.test(headSha)||!/^[a-f0-9]{64}$/.test(archiveSha256))throw Error('Pinned artifact identity required');
  const destination=path.resolve(output);
  if(destination.split(path.sep).some(x=>x.toLowerCase()==='public'))throw Error('Private archive cannot be under public');
  return {...value,output:destination,artifactId:String(artifactId)};
}
function safeDownload(url) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port)throw Error('Unexpected artifact redirect');
  if(parsed.hostname!=='objects.githubusercontent.com'&&!parsed.hostname.endsWith('.blob.core.windows.net')&&!parsed.hostname.endsWith('.actions.githubusercontent.com'))throw Error('Unexpected artifact storage host');
  return parsed.href;
}
/** Download only. Never extracts, promotes, modifies flags or logs bearer/signed URLs. */
export async function acquirePrivateRuntimeArtifact(options,{token,fetchImpl=fetch}={}) {
  const input=validateArtifactRequest(options);
  if(typeof token!=='string'||!token.trim())throw Error('GitHub actions-read credential required');
  const parent=path.dirname(input.output);const info=await lstat(parent);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('Existing private output directory required');
  const api=`https://api.github.com/repos/${input.repository}/actions/artifacts/${input.artifactId}`;
  const headers={authorization:`Bearer ${token}`,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  const repositoryResponse=await fetchImpl(`https://api.github.com/repos/${input.repository}`,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!repositoryResponse.ok)throw Error('Private repository unavailable');
  const repository=await repositoryResponse.json();
  if(repository.private!==true||repository.full_name?.toLowerCase()!==input.repository.toLowerCase())throw Error('Artifacts must originate in the explicitly selected private repository');
  const metadataResponse=await fetchImpl(api,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!metadataResponse.ok)throw Error('Artifact metadata unavailable');
  const metadata=await metadataResponse.json();
  if(String(metadata.id)!==input.artifactId||metadata.name!==input.artifactName||metadata.expired!==false||metadata.workflow_run?.head_sha!==input.headSha||!Number.isSafeInteger(metadata.size_in_bytes)||metadata.size_in_bytes<1||metadata.size_in_bytes>1_000_000_000)throw Error('Artifact identity or size mismatch');
  if(metadata.digest&&metadata.digest!==`sha256:${input.archiveSha256}`)throw Error('Artifact digest metadata mismatch');
  const redirect=await fetchImpl(api+'/zip',{headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(redirect.status!==302)throw Error('Expected GitHub artifact download redirect');
  let url=safeDownload(redirect.headers.get('location'));let response;
  for(let attempt=0;attempt<3;attempt++) {
    // Intentionally no Authorization header on storage requests.
    response=await fetchImpl(url,{redirect:'manual',signal:AbortSignal.timeout(300000)});
    if([301,302,303,307,308].includes(response.status)){url=safeDownload(response.headers.get('location'));continue;}
    break;
  }
  if(response?.status!==200||!response.body)throw Error('Artifact download unavailable');
  const hash=createHash('sha256');let bytes=0;
  const counter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>1_000_000_000){callback(Error('Artifact exceeds byte limit'));return;}hash.update(chunk);callback(null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),counter,createWriteStream(input.output,{flags:'wx',mode:0o600}));
  if(hash.digest('hex')!==input.archiveSha256)throw Error('Artifact archive hash mismatch; unverified output must not be used');
  const receipt={kind:'verified-private-runtime-archive',repository:input.repository,artifactId:input.artifactId,artifactName:input.artifactName,headSha:input.headSha,archiveSha256:input.archiveSha256,bytes,readyToServe:false};
  await writeFile(input.output+'.verified.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args={};const keys={'repository':'repository','artifact-id':'artifactId','artifact-name':'artifactName','head-sha':'headSha','archive-sha256':'archiveSha256','output':'output'};
  for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].slice(2),value=process.argv[i+1];if(!process.argv[i].startsWith('--')||!Object.hasOwn(keys,key)||args[keys[key]]||!value||value.startsWith('--'))throw Error('Invalid acquisition arguments');args[keys[key]]=value;}
  for(const key of Object.values(keys))if(!args[key])throw Error(`Missing ${key}`);
  try{console.log(JSON.stringify(await acquirePrivateRuntimeArtifact(args,{token:process.env.GH_TOKEN})));}
  catch{console.error('Private runtime acquisition failed. Check pinned identity, permissions, output and hash; no archive was approved for serving.');process.exitCode=1;}
}
