import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {nativeActor} from "../../lib/charmville/native-actor";
import {worldPresence} from "../../lib/charmville/world-presence";
import {requireNativeCrop} from "../../lib/charmville/native-crops";
import {nativeResources} from "../../lib/charmville/native-resources";
import {exchangeCommand} from "../../lib/charmville/exchange";
import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";
test("native crop definitions reject unsupported rewards",()=>{
 assert.equal(requireNativeCrop('oran-berry').growthSeconds,30);
 assert.ok(Object.isFrozen(requireNativeCrop('oran-berry')));
 for(const crop of ['burning-heart','toString','__proto__',''])assert.throws(()=>requireNativeCrop(crop),/Crop unavailable/);
});
test("native resources conserve seeds and produce across retries, ownership, cancellation and movement",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","116_charmville_soil.sql","118_charmville_home_access.sql","120_charmville_world_presence.sql","121_charmville_exchange.sql","125_charmville_native_actor.sql","126_charmville_native_resources.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}

  const a=await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);
  // Apply the additive migration over a planted legacy bed and pending action.
  const legacyRequest=randomUUID();
  await pool.query("INSERT INTO charmville_native_resources(region_id,bed_id,stage,planter_id) VALUES('public:meadow',2,2,$1)",[a.profileId]);
  await pool.query("INSERT INTO charmville_native_actions(profile_id,request_id,payload_hash,region_id,bed_id,kind,resource_revision,region_epoch,sequence,contact_at,expires_at) VALUES($1,$2,'legacy-hash','public:meadow',2,'water',0,$3,$4,clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 minute')",[a.profileId,legacyRequest,a.regionEpoch,a.sequence]);
  await pool.query(await readFile('deploy/inmotion/postgres/migrations/141_charmville_native_crop_identity.sql','utf8'));
  assert.equal((await pool.query("SELECT crop_id FROM charmville_native_resources WHERE bed_id=2")).rows[0].crop_id,'oran-berry');
  assert.equal((await pool.query("SELECT crop_id FROM charmville_native_actions WHERE request_id=$1",[legacyRequest])).rows[0].crop_id,'oran-berry');
  await pool.query("UPDATE charmville_native_actors SET x=11,y=9 WHERE profile_id=$1",[a.profileId]);
  const legacy=await nativeResources(pool,tokens[0],{phase:'commit',requestId:legacyRequest});
  assert.equal(legacy.beds[2].stage,3);
  assert.equal((await pool.query("SELECT payload_hash FROM charmville_native_actions WHERE request_id=$1",[legacyRequest])).rows[0].payload_hash,'legacy-hash');
  assert.deepEqual((await nativeResources(pool,tokens[0],{phase:'commit',requestId:legacyRequest})).result,legacy.result);
  await assert.rejects(pool.query("UPDATE charmville_native_resources SET crop_id='burning-heart' WHERE bed_id=2"),/check constraint/);
  await pool.query("UPDATE charmville_native_actors SET x=3,y=9");
  let state=await nativeResources(pool,tokens[0]);assert.equal(state.seeds,'3');assert.equal(state.beds[0].cropId,'oran-berry');assert.equal(state.beds[0].growthDurationMs,30000);assert.equal((await nativeResources(pool,tokens[0])).seeds,'3');assert.equal((await nativeResources(pool,tokens[1])).seeds,'3');
  const begin=async(kind:string,who=0)=>{const current=await nativeResources(pool,tokens[who]);const actor=await nativeActor(pool,tokens[who]);const requestId=randomUUID();const input={phase:'begin',requestId,kind,bedId:0,resourceRevision:current.beds[0].revision,regionEpoch:actor.regionEpoch,sequence:actor.sequence};await nativeResources(pool,tokens[who],input);return {requestId,input};};
  const mature=()=>pool.query("UPDATE charmville_native_actions SET contact_at=clock_timestamp()-interval '1 second' WHERE status='pending'");
  const finish=async(kind:string,who=0)=>{const r=await begin(kind,who);await mature();return nativeResources(pool,tokens[who],{phase:'commit',requestId:r.requestId});};
  const invalidActor=await nativeActor(pool,tokens[0]);
  for(const extra of [{cropId:'burning-heart'},{face:'burning-heart'},{quantity:99},{growthSeconds:0}])await assert.rejects(nativeResources(pool,tokens[0],{phase:'begin',requestId:randomUUID(),kind:'till',bedId:0,resourceRevision:'0',regionEpoch:invalidActor.regionEpoch,sequence:invalidActor.sequence,...extra}),/current bed action/);
  const till=await begin('till');assert.equal((await nativeResources(pool,tokens[0],till.input)).beds[0].stage,0);
  await pool.query("UPDATE charmville_native_actions SET contact_at=clock_timestamp()+interval '1 hour'");await assert.rejects(nativeResources(pool,tokens[0],{phase:'commit',requestId:till.requestId}),/contact/);
  await mature();const results=await Promise.all([nativeResources(pool,tokens[0],{phase:'commit',requestId:till.requestId}),nativeResources(pool,tokens[0],{phase:'commit',requestId:till.requestId})]);assert.equal(results[0].beds[0].revision,'1');assert.equal(results[1].beds[0].revision,'1');
  const cancelled=await begin('plant');await nativeResources(pool,tokens[0],{phase:'cancel',requestId:cancelled.requestId});await nativeResources(pool,tokens[0],{phase:'cancel',requestId:cancelled.requestId});await assert.rejects(nativeResources(pool,tokens[0],{phase:'commit',requestId:cancelled.requestId}),/cancelled/);
  state=await finish('plant');assert.equal(state.seeds,'2');
  state=await finish('water',1);assert.equal(state.beds[0].stage,3);assert.ok(Math.abs(new Date(state.beds[0].readyAt).getTime()-new Date(state.serverNow).getTime()-30000)<2000);
  await pool.query("UPDATE charmville_native_resources SET ready_at=clock_timestamp()-interval '1 second'");await assert.rejects(begin('harvest',1),/planter/);
  state=await finish('harvest');assert.equal(state.produce,'1');assert.equal(state.seeds,'3');assert.equal(state.beds[0].stage,1);
  const offer=await exchangeCommand(pool,tokens[0],{kind:'create',requestId:randomUUID(),side:'sell',face:'oran-berry',quantity:'1',price:'2'});
  assert.equal((await nativeResources(pool,tokens[0])).produce,'0');
  await exchangeCommand(pool,tokens[0],{kind:'cancel',requestId:randomUUID(),offerId:offer.offerId});assert.equal((await nativeResources(pool,tokens[0])).produce,'1');
  const moving=await begin('plant');await pool.query("UPDATE charmville_native_actors SET sequence=sequence+1 WHERE profile_id=$1",[a.profileId]);await mature();await assert.rejects(nativeResources(pool,tokens[0],{phase:'commit',requestId:moving.requestId}),/Movement/);await nativeResources(pool,tokens[0],{phase:'cancel',requestId:moving.requestId});
  const expired=await begin('plant');await pool.query("UPDATE charmville_native_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",[expired.requestId]);await assert.rejects(nativeResources(pool,tokens[0],{phase:'commit',requestId:expired.requestId}),/expired/);
  assert.equal((await nativeResources(pool,tokens[0])).seeds,'3');assert.equal((await pool.query('SELECT grain FROM charmville_yards WHERE profile_id=$1',[a.profileId])).rows[0].grain,'0');
  await nativeResources(pool,tokens[0],{phase:'cancel',requestId:expired.requestId});
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");
  const presence=await worldPresence(pool,tokens[0]);await worldPresence(pool,tokens[0],{destination:'home',handle:'p0',revision:presence.revision});await nativeActor(pool,tokens[0]);
  await finish('till');await finish('plant');
  await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'0',revoke:false,rights:['visit','help'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  const visitor=await worldPresence(pool,tokens[1]);await worldPresence(pool,tokens[1],{destination:'home',handle:'p0',revision:visitor.revision});await nativeActor(pool,tokens[1]);
  assert.deepEqual((await nativeResources(pool,tokens[1])).beds[0].allowedActions,['water']);
  const water=await begin('water',1);await mature();
  await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'1',revoke:false,rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));
  assert.deepEqual((await nativeResources(pool,tokens[1])).beds[0].allowedActions,[]);
  await assert.rejects(nativeResources(pool,tokens[1],{phase:'commit',requestId:water.requestId}),/permission/);assert.equal((await nativeResources(pool,tokens[0])).beds[0].stage,2);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
