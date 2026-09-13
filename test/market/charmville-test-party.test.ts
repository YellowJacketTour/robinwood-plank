import {testParty} from "../../lib/charmville/test-party";
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
test("trusted sandbox party grants six unique species once and supports switching",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","119_charmville_test_party.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  assert.equal((await testParty(pool,tokens[0])).eligible,false);await assert.rejects(testParty(pool,tokens[0],true),/sandbox/);
  await pool.query('INSERT INTO charmville_local_playtest_accounts(profile_id) VALUES($1)',[owner]);await testParty(pool,tokens[0],true);const entities=(await pool.query('SELECT id,source_species_id FROM charmville_creature_entities WHERE owner_profile_id=$1 ORDER BY source_species_id',[owner])).rows;assert.equal(entities.length,6);assert.equal(new Set(entities.map(r=>r.source_species_id)).size,6);assert.equal(entities.find(r=>r.source_species_id===277).id,creatureId);await testParty(pool,tokens[0],true);assert.deepEqual((await pool.query('SELECT id,source_species_id FROM charmville_creature_entities WHERE owner_profile_id=$1 ORDER BY source_species_id',[owner])).rows,entities);
  const health=await creatureVitals(pool,tokens[0]);assert.equal(health.creatures.find(r=>r.speciesId===25).level,11);
  await nativeActor(pool,tokens[0]);let encounter=await worldEncounter(pool,tokens[0]);for(const action of ['claim','enter-turn'])encounter=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:encounter.encounter.id,revision:encounter.encounter.revision,actorEpoch:encounter.actorEpoch});
  const b=await turnBattle(pool,tokens[0]);assert.equal(b.eligible.length,6);const pika=b.eligible.find(r=>r.speciesId===25)!;assert.equal(pika.move.id,98);assert.equal(pika.move.maxPp,30);
  const q={action:'switch',requestId:randomUUID(),encounterId:b.encounterId,revision:b.revision,actorEpoch:encounter.actorEpoch,creatureId:pika.id};const switched=await turnBattle(pool,tokens[0],q);assert.equal(switched.partner?.id,pika.id);assert.equal(switched.partner?.move.pp,pika.move.pp);assert.equal(switched.wild.hp,b.wild.hp);assert.deepEqual(await turnBattle(pool,tokens[0],q),switched);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
