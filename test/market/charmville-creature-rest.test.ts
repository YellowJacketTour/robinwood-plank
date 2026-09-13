import {creatureRest} from "../../lib/charmville/creature-rest";
import {turnBattle} from "../../lib/charmville/turn-battle";
import {worldEncounter} from "../../lib/charmville/encounters";
import {nativeActor} from "../../lib/charmville/native-actor";
import {normalDamage} from "../../lib/charmville/battle-math";
import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("owned home rest recovers actual battle HP and PP once",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","118_charmville_creature_rest.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  await creatureVitals(pool,tokens[0]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[owner]);await pool.query('INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,0,$2)',[owner,creatureId]);
  await nativeActor(pool,tokens[0]);let e=await worldEncounter(pool,tokens[0]);const lifecycle=async(action:string)=>{e=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch});};await lifecycle('claim');await lifecycle('enter-turn');
  const initial=await turnBattle(pool,tokens[0]);assert.equal(initial.eligible[0].move.id,1);const q={action:'attack',requestId:randomUUID(),encounterId:initial.encounterId,revision:initial.revision,actorEpoch:e.actorEpoch,creatureId,moveId:1};
  const results=await Promise.all([turnBattle(pool,tokens[0],q),turnBattle(pool,tokens[0],q)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].turn,1);assert.equal(results[0].partner?.move.pp,initial.eligible[0].move.pp-1);assert.ok(results[0].wild.hp<=initial.wild.hp);assert.equal((await creatureVitals(pool,tokens[0])).creatures[0].hp,results[0].partner?.hp);
  await assert.rejects(turnBattle(pool,tokens[0],{...q,requestId:randomUUID(),damage:999}),/Invalid/);
  await pool.query('UPDATE charmville_creature_combat SET pp=0 WHERE creature_id=$1',[creatureId]);await assert.rejects(turnBattle(pool,tokens[0],{...q,requestId:randomUUID(),revision:results[0].revision}),/unavailable/);assert.equal((await turnBattle(pool,tokens[0])).turn,1);
  const ivs=(await pool.query('SELECT attack_iv,defense_iv,speed_iv FROM charmville_wild_combat')).rows[0];e=await worldEncounter(pool,tokens[0]);await lifecycle('return-world');await lifecycle('enter-turn');assert.deepEqual((await pool.query('SELECT attack_iv,defense_iv,speed_iv FROM charmville_wild_combat')).rows[0],ivs);assert.equal((await turnBattle(pool,tokens[0])).wild.hp,results[0].wild.hp);
  await pool.query('UPDATE charmville_creature_combat SET pp=10 WHERE creature_id=$1',[creatureId]);await pool.query('UPDATE charmville_creature_vitals SET hp=0 WHERE creature_id=$1',[creatureId]);const current=await turnBattle(pool,tokens[0]);await assert.rejects(turnBattle(pool,tokens[0],{...q,requestId:randomUUID(),revision:current.revision}),/unavailable/);assert.equal((await creatureVitals(pool,tokens[0])).oranQuantity,'3');
  e=await worldEncounter(pool,tokens[0]);await lifecycle('return-world');await lifecycle('release');
  await pool.query("UPDATE charmville_world_presence SET changed_at=clock_timestamp()-interval '2 seconds'");const location=await worldPresence(pool,tokens[0]);await worldPresence(pool,tokens[0],{destination:'home',handle:'p0',revision:location.revision});await nativeActor(pool,tokens[0]);
  const before=(await pool.query('SELECT * FROM charmville_creature_combat WHERE creature_id=$1',[creatureId])).rows[0];const restId=randomUUID();await creatureRest(pool,tokens[0],{phase:'begin',requestId:restId,creatureId});
  await pool.query("UPDATE charmville_creature_rest SET ready_at=clock_timestamp()+interval '1 hour'");await assert.rejects(creatureRest(pool,tokens[0],{phase:'commit',requestId:restId}),/not finished/);
  await pool.query("UPDATE charmville_creature_rest SET ready_at=clock_timestamp()-interval '1 second'");await creatureRest(pool,tokens[0],{phase:'commit',requestId:restId});const healed=await creatureVitals(pool,tokens[0]);assert.equal(healed.creatures[0].hp,healed.creatures[0].maxHp);const combat=(await pool.query('SELECT * FROM charmville_creature_combat WHERE creature_id=$1',[creatureId])).rows[0];assert.equal(combat.pp,35);assert.equal(combat.attack_iv,before.attack_iv);assert.equal(combat.defense_iv,before.defense_iv);
  await pool.query('UPDATE charmville_creature_vitals SET hp=1 WHERE creature_id=$1',[creatureId]);await creatureRest(pool,tokens[0],{phase:'commit',requestId:restId});assert.equal((await creatureVitals(pool,tokens[0])).creatures[0].hp,1);
  const interrupted=randomUUID();await creatureRest(pool,tokens[0],{phase:'begin',requestId:interrupted,creatureId});await pool.query('UPDATE charmville_native_actors SET sequence=sequence+1');await assert.rejects(creatureRest(pool,tokens[0],{phase:'commit',requestId:interrupted}),/interrupted/);await creatureRest(pool,tokens[0],{phase:'cancel',requestId:interrupted});
  const battleRest=randomUUID();await creatureRest(pool,tokens[0],{phase:'begin',requestId:battleRest,creatureId});e=await worldEncounter(pool,tokens[0]);await lifecycle('claim');await lifecycle('enter-turn');await lifecycle('return-world');await lifecycle('release');await assert.rejects(creatureRest(pool,tokens[0],{phase:'commit',requestId:battleRest}),/cancelled/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
test('neutral normal damage source integer and critical order vectors',()=>{assert.equal(normalDamage(5,10,7,40,false,100),6);assert.equal(normalDamage(5,10,7,40,true,85),10);assert.equal(normalDamage(2,7,9,35,false,85),2);});



