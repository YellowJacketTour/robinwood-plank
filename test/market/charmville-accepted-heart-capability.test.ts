import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {acceptedHeartCapability,readAcceptedHeartCapability} from '../../lib/charmville/accepted-heart-capability';
import {familyAcceptanceEnabled} from '../../lib/charmville/family-acceptance-request';
import {nativeResourceRequestPolicy} from '../../lib/charmville/native-resource-negotiation';
import {heartSocialPolicy} from '../../lib/charmville/social-policy';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const declaration={nativeProtocol:2,familyEntitlement:'burning-heart-family-alpha-01',socialProtocol:'social-items-v2',schemaMigration:148};
const checks=Object.fromEntries(['coldStart','movement','farmingHarvest','reloadPersistence','socialPin','ticketRenewal','unauthorizedDenied','revokedDenied','burningHeartLifecycle'].map(key=>[key,true]));
test('selected accepted package enables negotiated Heart policies; arbitrary env flags cannot',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'heart-release-policy-'));
 const env={NODE_ENV:'production',CHARMVILLE_RUNTIME_READY:'1',CHARMVILLE_RUNTIME_ROOT:root,CHARMVILLE_RUNTIME_RELEASE:'alpha02'};
 const inventory={schemaVersion:1,scope:'joined-homestead-private-inventory',completeInventory:true,files:[{root:'runtime',path:'test-fixture.txt',role:'served',status:'present'}],issues:[],capabilities:{burningHeart:declaration}};
 async function write(options:{origin?:string;ready?:boolean;kind?:string;heartCheck?:boolean;capability?:object}={}){
  const raw=JSON.stringify({...inventory,capabilities:{burningHeart:options.capability??declaration}}),digest=hash(raw);
  const evidence=JSON.stringify({schemaVersion:1,kind:'charmville-runtime-browser-acceptance',targetInventorySha256:digest,checks:{...checks,burningHeartLifecycle:options.heartCheck??true}});
  await writeFile(path.join(root,'inventory.json'),raw);await writeFile(path.join(root,'BROWSER-ACCEPTANCE.json'),evidence);
  await writeFile(path.join(root,'PACKAGE-COMPLETE.json'),JSON.stringify({kind:options.kind??'charmville-runtime-release',readyToServe:options.ready??true,release:'alpha02',accountOrigin:options.origin??'https://plank.love',inventorySha256:digest,acceptanceSha256:hash(evidence)}));
 }
 try {
  assert.equal(await readAcceptedHeartCapability({...env,CHARMVILLE_FAMILY_OPENING_VERSION:'burning-heart-family-alpha-01',CHARMVILLE_NATIVE_CROP_PROTOCOL:'2',CHARMVILLE_LOCAL_HEART_SOCIAL:'1'}),false);
  await write();const accepted=await readAcceptedHeartCapability(env);assert.equal(accepted,true);
  assert.equal(familyAcceptanceEnabled(env,accepted),true);
  const request=new Request('http://internal/api',{headers:{'x-charmville-resource-protocol':'2','x-charmville-resource-crops':'oran-berry,burning-heart','x-charmville-social-protocol':'social-items-v2'}});
  assert.equal(nativeResourceRequestPolicy(request,env,accepted)?.burningHeartEnabled,true);
  assert.equal(heartSocialPolicy(request,env,accepted)?.burningHeart,true);
  assert.equal(nativeResourceRequestPolicy(new Request('https://plank.love/api'),env,accepted),undefined);
  assert.equal(heartSocialPolicy(new Request('https://plank.love/api'),env,accepted),undefined);
  assert.equal(await acceptedHeartCapability(env),true);
  assert.equal(await acceptedHeartCapability({...env,CHARMVILLE_RUNTIME_READY:'0'}),false); // Immediate kill despite positive cache.
  for(const options of [{origin:'http://localhost:3018'},{ready:false},{kind:'charmville-runtime-candidate'},{heartCheck:false},{capability:{...declaration,nativeProtocol:1}},{capability:{...declaration,arbitrary:true}}]){
   await write(options);assert.equal(await readAcceptedHeartCapability(env),false);
  }
  await write();await writeFile(path.join(root,'BROWSER-ACCEPTANCE.json'),'{}');assert.equal(await readAcceptedHeartCapability(env),false);
  await write();await writeFile(path.join(root,'inventory.json'),JSON.stringify(inventory)+' ');assert.equal(await readAcceptedHeartCapability(env),false);
  await write();assert.equal(await readAcceptedHeartCapability({...env,CHARMVILLE_RUNTIME_RELEASE:'different'}),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
