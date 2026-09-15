import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {readRuntimeRelease} from './runtime-release';
import {FAMILY_ENTITLEMENT_VERSION} from './family-entitlement-contract';

type Environment=Record<string,string|undefined>;
/** This inspects only server-owned release metadata, never serves private art.
 * Every actual account read/mutation still performs current session/admission
 * checks. No client capability or general Heart environment flag enables it. */
export async function readAcceptedHeartCapability(env:Environment=process.env):Promise<boolean> {
 if(env.NODE_ENV!=='production'||env.CHARMVILLE_RUNTIME_READY!=='1'||!env.CHARMVILLE_RUNTIME_ROOT||!env.CHARMVILLE_RUNTIME_RELEASE)return false;
 try {
  const release=await readRuntimeRelease(env.CHARMVILLE_RUNTIME_ROOT,env.CHARMVILLE_RUNTIME_RELEASE);
  const {manifest,receipt}=release;
  if(receipt.kind!=='charmville-runtime-release'||receipt.accountOrigin!=='https://plank.love'||manifest.schemaVersion!==1||manifest.scope!=='joined-homestead-private-inventory'||manifest.completeInventory!==true||!Array.isArray(manifest.files)||manifest.files.length===0||!Array.isArray(manifest.issues)||manifest.issues.length)return false;
  const capability=manifest.capabilities?.burningHeart;
  if(!capability||Object.keys(capability).sort().join(',')!=='familyEntitlement,nativeProtocol,schemaMigration,socialProtocol'||capability.nativeProtocol!==2||capability.familyEntitlement!==FAMILY_ENTITLEMENT_VERSION||capability.socialProtocol!=='social-items-v2'||capability.schemaMigration!==148)return false;
  const filename=path.join(env.CHARMVILLE_RUNTIME_ROOT,'BROWSER-ACCEPTANCE.json'),info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>2_000_000)return false;
  const raw=await readFile(filename);
  if(createHash('sha256').update(raw).digest('hex')!==receipt.acceptanceSha256)return false;
  const evidence=JSON.parse(raw.toString('utf8'));
  const checks=['coldStart','movement','farmingHarvest','reloadPersistence','socialPin','ticketRenewal','unauthorizedDenied','revokedDenied','burningHeartLifecycle'];
  return evidence.kind==='charmville-runtime-browser-acceptance'&&evidence.schemaVersion===1&&evidence.targetInventorySha256===receipt.inventorySha256&&checks.every(key=>evidence.checks?.[key]===true);
 }catch{return false;}
}

let cached:{key:string;until:number;value:Promise<boolean>}|undefined;
/** Collapse concurrent metadata reads for one immutable release. Kill switch
 * and selected-root changes take effect immediately; receipts/admission are
 * never cached here. Reinspect package metadata at least once per second. */
export function acceptedHeartCapability(env:Environment=process.env):Promise<boolean>{
 if(env.NODE_ENV!=='production'||env.CHARMVILLE_RUNTIME_READY!=='1'||!env.CHARMVILLE_RUNTIME_ROOT||!env.CHARMVILLE_RUNTIME_RELEASE)return Promise.resolve(false);
 const key=JSON.stringify([env.CHARMVILLE_RUNTIME_ROOT,env.CHARMVILLE_RUNTIME_RELEASE]);
 if(cached?.key===key&&cached.until>Date.now())return cached.value;
 const value=readAcceptedHeartCapability(env);cached={key,until:Date.now()+1000,value};return value;
}
