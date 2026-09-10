import {HABITAT_SPAWN_LIMIT} from '../../lib/charmville/habitat';
import {worldEncounter} from "../../lib/charmville/encounters";
import {nativeActor} from "../../lib/charmville/native-actor";
import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("habitat refresh retains terminal UUIDs and obeys renewable budget",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","123_charmville_capture.sql","126_charmville_habitat.sql","127_charmville_habitat_budget.sql","120_charmville_battle_events.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  await creatureVitals(pool,tokens[0]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[owner]);await pool.query('INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,0,$2)',[owner,creatureId]);
  await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);let e=await worldEncounter(pool,tokens[0]);const lifecycle=async(action:string)=>{e=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch});};await lifecycle('claim');await lifecycle('enter-turn');
  const original=e.encounter.id;await pool.query('UPDATE charmville_encounters SET hp=0 WHERE id=$1',[original]);const waiting=await worldEncounter(pool,tokens[0]);assert.equal(waiting.encounter.id,original);assert.ok(waiting.habitat?.nextSpawnAt);assert.deepEqual(waiting.legalActions,[]);
  await pool.query("UPDATE charmville_encounters SET terminal_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[original]);
  const parallel=await Promise.all([worldEncounter(pool,tokens[0]),worldEncounter(pool,tokens[1])]);assert.equal(parallel[0].encounter.id,parallel[1].encounter.id);assert.notEqual(parallel[0].encounter.id,original);assert.equal(parallel[0].habitat?.spawnCount,2);
  const archive=(await pool.query('SELECT * FROM charmville_encounters WHERE id=$1',[original])).rows[0];assert.equal(archive.hp,0);assert.equal(archive.origin_region_id,'public:meadow');assert.equal(archive.region_id,`archive:${original}`);
  let current=parallel[0];await pool.query("UPDATE charmville_encounters SET captured=true,terminal_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[current.encounter.id]);current=await worldEncounter(pool,tokens[0]);assert.equal(current.habitat?.spawnCount,3);
  await pool.query("UPDATE charmville_habitat_budget SET spawn_count=$1 WHERE region_id='public:meadow'",[HABITAT_SPAWN_LIMIT]);
  await pool.query("UPDATE charmville_encounters SET hp=0,terminal_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[current.encounter.id]);const exhausted=await worldEncounter(pool,tokens[0]);assert.equal(exhausted.encounter.id,current.encounter.id);assert.ok(exhausted.habitat?.nextSpawnAt);
  await pool.query("UPDATE charmville_habitat_budget SET window_started_at=clock_timestamp()-interval '61 minutes' WHERE region_id='public:meadow'");const renewable=await worldEncounter(pool,tokens[0]);assert.notEqual(renewable.encounter.id,current.encounter.id);assert.equal(renewable.habitat?.spawnCount,1);assert.equal((await pool.query("SELECT count(*) FROM charmville_encounters WHERE origin_region_id='public:meadow'")).rows[0].count,'4');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
