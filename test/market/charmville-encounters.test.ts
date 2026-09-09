import {worldEncounter} from "../../lib/charmville/encounters";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {nativeActor} from "../../lib/charmville/native-actor";
import {worldPresence} from "../../lib/charmville/world-presence";
import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";
test("encounter lifecycle preserves identity HP status and isolates control across replay lease and admission",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","113_charmville_native_actor.sql","116_charmville_encounters.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}

  await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);
  const initial=await worldEncounter(pool,tokens[0]);assert.equal(initial.encounter.speciesId,286);assert.deepEqual(initial.legalActions,['claim']);
  const command={requestId:randomUUID(),encounterId:initial.encounter.id,revision:initial.encounter.revision,actorEpoch:initial.actorEpoch,action:'claim'};
  const claimed=await worldEncounter(pool,tokens[0],command);assert.deepEqual(await worldEncounter(pool,tokens[0],command),claimed);await assert.rejects(worldEncounter(pool,tokens[1],{...command,requestId:randomUUID(),revision:claimed.encounter.revision}),/Another/);
  // Trusted fixture status/damage only, no client endpoint can supply either.
  await pool.query("UPDATE charmville_encounters SET hp=hp-1,statuses=ARRAY['poison'] WHERE id=$1",[initial.encounter.id]);
  const act=async(action:string)=>{const s=await worldEncounter(pool,tokens[0]);return worldEncounter(pool,tokens[0],{...command,requestId:randomUUID(),action,revision:s.encounter.revision});};
  const inspected=await act('enter-turn');assert.equal(inspected.encounter.mode,'turn');assert.equal(inspected.encounter.hp,initial.encounter.hp-1);assert.deepEqual(inspected.encounter.statuses,['poison']);const returned=await act('return-world');assert.equal(returned.encounter.hp,inspected.encounter.hp);assert.deepEqual(returned.encounter.statuses,inspected.encounter.statuses);
  await pool.query("UPDATE charmville_encounters SET lease_until=clock_timestamp()-interval '1 second'");const expired=await worldEncounter(pool,tokens[1]);assert.equal(expired.encounter.controllerId,null);assert.equal(expired.encounter.id,initial.encounter.id);
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");const p=await worldPresence(pool,tokens[0]);await worldPresence(pool,tokens[0],{destination:'home',handle:'p0',revision:p.revision});await nativeActor(pool,tokens[0]);
  await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'0',revoke:false,rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));const pv=await worldPresence(pool,tokens[1]);await worldPresence(pool,tokens[1],{destination:'home',handle:'p0',revision:pv.revision});await nativeActor(pool,tokens[1]);const home=await worldEncounter(pool,tokens[1]);assert.notEqual(home.encounter.id,initial.encounter.id);await worldEncounter(pool,tokens[1],{...command,requestId:randomUUID(),encounterId:home.encounter.id,revision:home.encounter.revision,actorEpoch:home.actorEpoch});
  await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'1',revoke:true}));assert.equal((await worldEncounter(pool,tokens[0])).encounter.controllerId,null);await assert.rejects(worldEncounter(pool,tokens[1]),/permission/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
