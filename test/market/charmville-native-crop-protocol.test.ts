import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {nativeResources,type NativeResourcePolicy} from "../../lib/charmville/native-resources";
import {nativeActor} from "../../lib/charmville/native-actor";
import {worldPresence} from "../../lib/charmville/world-presence";
import {acceptFamilySeeds} from "../../lib/charmville/family-entitlement";

test("explicit crop protocol preserves identity, custody, stale guards and legacy isolation",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;
 assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`crop_${randomUUID().replaceAll("-","")}`;
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 const token="d".repeat(64),wallet=`0x${"4".repeat(40)}`;
 const mode=process.env.CHARMVILLE_ACCESS_MODE,admins=process.env.CHARMVILLE_ADMIN_WALLETS;
 process.env.CHARMVILLE_ACCESS_MODE="private";process.env.CHARMVILLE_ADMIN_WALLETS=wallet;
 const policy:NativeResourcePolicy={protocolVersion:2,burningHeartEnabled:true};
 const state=(raw?:unknown)=>nativeResources(pool,token,raw,policy);
 try {
  for(const f of ["090_plankspace_native.sql","116_charmville_soil.sql","118_charmville_home_access.sql","120_charmville_world_presence.sql","121_charmville_exchange.sql","125_charmville_native_actor.sql","126_charmville_native_resources.sql","141_charmville_native_crop_identity.sql","147_charmville_burning_heart_foundation.sql"])
   await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const id=(await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,'crop_protocol','Crop','approved') RETURNING id",[wallet])).rows[0].id;
  await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(token).digest("hex"),wallet]);
  await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[id]);
  await worldPresence(pool,token,{destination:"public",revision:"0"});await nativeActor(pool,token);
  await pool.query("UPDATE charmville_native_actors SET x=3,y=9 WHERE profile_id=$1",[id]);
  await acceptFamilySeeds(pool,token,{enabled:true});
  const input=async(kind:string,cropId?:string)=>{
   const s=await state(),actor=await nativeActor(pool,token);
   return {phase:"begin",requestId:randomUUID(),kind,bedId:0,resourceRevision:s.beds[0].revision,regionEpoch:actor.regionEpoch,sequence:actor.sequence,...(cropId?{cropId}:{})};
  };
  const contact=()=>pool.query("UPDATE charmville_native_actions SET contact_at=clock_timestamp()-interval '1 second' WHERE status='pending'");
  const finish=async(kind:string,cropId?:string)=>{const q=await input(kind,cropId);await state(q);await contact();return state({phase:"commit",requestId:q.requestId});};
  assert.equal((await state()).cropBalances?.["burning-heart"].seeds,"3");
  assert.equal((await nativeResources(pool,token)).protocolVersion,undefined);
  await finish("till");
  const q=await input("plant","burning-heart");
  await assert.rejects(nativeResources(pool,token,q),/current bed action/);
  await assert.rejects(nativeResources(pool,token,q,{protocolVersion:2,burningHeartEnabled:false}),/Crop unavailable/);
  await state(q);
  assert.equal((await state()).beds[0].cropId,"oran-berry"); // No premature art change.
  await assert.rejects(state({...q,cropId:"oran-berry"}),/already used/);
  await contact();
  await assert.rejects(nativeResources(pool,token,{phase:"commit",requestId:q.requestId}),/Crop unavailable/);
  const planted=await Promise.all([state({phase:"commit",requestId:q.requestId}),state({phase:"commit",requestId:q.requestId})]);
  assert.deepEqual(planted[0].result,planted[1].result);
  assert.equal(planted[0].beds[0].cropId,"burning-heart");
  assert.equal(planted[0].cropBalances?.["burning-heart"].seeds,"2");
  assert.equal(planted[0].seeds,"3");
  await assert.rejects(nativeResources(pool,token),/Crop unavailable/);
  await assert.rejects(state(await input("plant","oran-berry")),/not ready/);
  await assert.rejects(state(await input("water","oran-berry")),/when planting/);
  const watered=await finish("water");
  assert.equal(watered.beds[0].growthDurationMs,30000);
  assert.ok(Math.abs(Date.parse(watered.beds[0].readyAt)-Date.parse(watered.serverNow)-30000)<2000);
  await pool.query("UPDATE charmville_native_resources SET ready_at=clock_timestamp()-interval '1 second' WHERE bed_id=0");
  const harvested=await finish("harvest");
  assert.equal(harvested.cropBalances?.["burning-heart"].produce,"1");assert.equal(harvested.cropBalances?.["burning-heart"].seeds,"3");assert.equal(harvested.produce,"0");
  const stale=await input("plant","oran-berry");await state(stale);
  await pool.query("UPDATE charmville_native_resources SET revision=revision+1 WHERE bed_id=0");await contact();
  await assert.rejects(state({phase:"commit",requestId:stale.requestId}),/bed changed/);
  await state({phase:"cancel",requestId:stale.requestId});
  const restored=await finish("plant","oran-berry");
  assert.equal(restored.beds[0].cropId,"oran-berry");assert.equal(restored.seeds,"2");
  assert.equal((await nativeResources(pool,token)).beds[0].cropId,"oran-berry");
 } finally {
  if(mode===undefined)delete process.env.CHARMVILLE_ACCESS_MODE;else process.env.CHARMVILLE_ACCESS_MODE=mode;
  if(admins===undefined)delete process.env.CHARMVILLE_ADMIN_WALLETS;else process.env.CHARMVILLE_ADMIN_WALLETS=admins;
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});
