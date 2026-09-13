import {homeAccess,parseHomeGrant} from "../../lib/charmville/home-access-store";
import {inviteBattleAssist} from "../../lib/charmville/battle-assist";
import {turnBattle} from "../../lib/charmville/turn-battle";
import {worldEncounter} from "../../lib/charmville/encounters";
import {nativeActor} from "../../lib/charmville/native-actor";
import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("consented helper contributes once to shared HP without taking controller",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","120_charmville_battle_events.sql","121_charmville_battle_assist.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  await creatureVitals(pool,tokens[0]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[owner]);await pool.query('INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,0,$2)',[owner,creatureId]);
  await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);let e=await worldEncounter(pool,tokens[0]);const lifecycle=async(action:string)=>{e=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch});};await lifecycle('claim');await lifecycle('enter-turn');

  const helper=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p1'")).rows[0].id;const helperCreature=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[helperCreature,helper]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[helper]);await pool.query('INSERT INTO charmville_creature_slots VALUES($1,0,$2)',[helper,helperCreature]);await creatureVitals(pool,tokens[1]);
  let current=await turnBattle(pool,tokens[0]);current=await turnBattle(pool,tokens[0],{action:'switch',requestId:randomUUID(),encounterId:current.encounterId,revision:current.revision,actorEpoch:e.actorEpoch,creatureId});const controllerHp=current.partner!.hp;
  await assert.rejects(turnBattle(pool,tokens[1]),/assist/);
  const invite={helperProfileId:helper,requestId:randomUUID(),revision:current.revision,actorEpoch:e.actorEpoch};await inviteBattleAssist(pool,tokens[0],invite);assert.equal((await worldEncounter(pool,tokens[1])).canAssist,true);
  const ready=await turnBattle(pool,tokens[1]);assert.equal(ready.role,'assistant');const q={action:'assist',requestId:randomUUID(),encounterId:ready.encounterId,revision:ready.revision,actorEpoch:e.actorEpoch,creatureId:helperCreature,moveId:1};const [done,replay]=await Promise.all([turnBattle(pool,tokens[1],q),turnBattle(pool,tokens[1],q)]);assert.deepEqual(done,replay);assert.equal(done.canAssist,false);assert.equal(done.eligible[0].move.pp,34);assert.ok(done.wild.hp<ready.wild.hp);
  const ownerState=await turnBattle(pool,tokens[0]);assert.equal(ownerState.partner!.id,creatureId);assert.equal(ownerState.partner!.hp,controllerHp);assert.equal((await worldEncounter(pool,tokens[0])).encounter.controllerId,owner);
  await inviteBattleAssist(pool,tokens[0],invite);assert.equal((await worldEncounter(pool,tokens[1])).canAssist,false,'same invite cannot replenish consumed grant');await assert.rejects(turnBattle(pool,tokens[1],{...q,requestId:randomUUID(),revision:done.revision}),/assist/);
  const logs=(await worldEncounter(pool,tokens[0])).events;assert.equal(logs.length,2);assert.ok(logs[1].log[0].actorCell);assert.equal(logs[1].log[0].moveId,1);
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");for(let i=0;i<2;i++){if(i===1)await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'0',revoke:false,rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString()}));const loc=await worldPresence(pool,tokens[i]);await worldPresence(pool,tokens[i],{destination:'home',handle:'p0',revision:loc.revision});await nativeActor(pool,tokens[i]);}
  e=await worldEncounter(pool,tokens[0]);await lifecycle('claim');await lifecycle('enter-turn');await inviteBattleAssist(pool,tokens[0],{...invite,requestId:randomUUID(),revision:e.encounter.revision,actorEpoch:e.actorEpoch});assert.equal((await worldEncounter(pool,tokens[1])).canAssist,true);
  await pool.query("UPDATE charmville_battle_assists SET expires_at=clock_timestamp()-interval '1 second'");assert.equal((await worldEncounter(pool,tokens[1])).canAssist,false);
  await inviteBattleAssist(pool,tokens[0],{...invite,requestId:randomUUID(),revision:e.encounter.revision,actorEpoch:e.actorEpoch});await lifecycle('return-world');await lifecycle('enter-turn');assert.equal((await worldEncounter(pool,tokens[1])).canAssist,false);
  await inviteBattleAssist(pool,tokens[0],{...invite,requestId:randomUUID(),revision:e.encounter.revision,actorEpoch:e.actorEpoch});await pool.query("UPDATE charmville_world_presence SET expires_at=clock_timestamp()-interval '1 second' WHERE profile_id=$1",[owner]);assert.equal((await worldEncounter(pool,tokens[1])).canAssist,false);await pool.query("UPDATE charmville_world_presence SET expires_at=clock_timestamp()+interval '90 seconds' WHERE profile_id=$1",[owner]);
  await assert.rejects(inviteBattleAssist(pool,tokens[0],{...invite,requestId:'-'.repeat(36)}),/Choose/);
  await homeAccess(pool,'p0',tokens[0],parseHomeGrant({visitor:'p1',revision:'1',revoke:true}));await assert.rejects(turnBattle(pool,tokens[1]),/permission/);assert.equal((await creatureVitals(pool,tokens[0])).oranQuantity,'3');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});


