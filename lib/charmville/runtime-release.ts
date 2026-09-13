import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';
import {RuntimeArtifactError, type RuntimeRoots} from './runtime-artifact';

/** Load only a completed, operator-owned runnable release. Input-only exports
 * deliberately fail this gate. Call after admission; never accept client paths. */
export async function readRuntimeRelease(root:string, release:string, options:{localCandidate?:boolean}={}) {
  const fail=():never=>{throw new RuntimeArtifactError(503);};
  if(!path.isAbsolute(root)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(release))return fail();
  const absolute=path.resolve(root);
  let cursor=path.parse(absolute).root;
  for(const part of absolute.slice(cursor.length).split(path.sep)) {
    cursor=path.join(cursor,part);
    if((await lstat(cursor)).isSymbolicLink())return fail();
  }
  async function smallFile(name:string) {
    const filename=path.join(absolute,name),info=await lstat(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.size>2_000_000)return fail();
    return readFile(filename,'utf8');
  }
  const receipt=JSON.parse(await smallFile('PACKAGE-COMPLETE.json'));
  const accepted=receipt.kind==='charmville-runtime-release'&&receipt.readyToServe===true;
  const localCandidate=options.localCandidate===true&&receipt.kind==='charmville-runtime-candidate'&&receipt.readyToServe===false&&receipt.accountOrigin==='http://localhost:3018';
  if((!accepted&&!localCandidate)||receipt.release!==release||
    typeof receipt.inventorySha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.inventorySha256))return fail();
  const inventory=await smallFile('inventory.json');
  if(createHash('sha256').update(inventory).digest('hex')!==receipt.inventorySha256)return fail();
  // The native package is independently verified and staged by the release
  // workflow; Next must not infer a copy of the whole checkout from this root.
  const roots=Object.fromEntries(['repo','runtime','content','sprite'].map(key=>[key,path.join(/* turbopackIgnore: true */ absolute,key)])) as RuntimeRoots;
  return {manifest:JSON.parse(inventory),roots,configuredRelease:release};
}
