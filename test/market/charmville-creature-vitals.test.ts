import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("source vitals persist and Oran use conserves inventory under replay and ownership checks",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);
  const first=await creatureVitals(pool,tokens[0]);assert.equal(first.creatures.length,1);assert.equal(first.creatures[0].hp,first.creatures[0].maxHp);assert.deepEqual(await creatureVitals(pool,tokens[0]),first);
  const command={requestId:randomUUID(),action:'use-oran',creatureId,revision:'0'};
  await assert.rejects(creatureVitals(pool,tokens[0],command),/full health/);await assert.rejects(creatureVitals(pool,tokens[1],command),/own/);
  // Damage is an isolated test fixture, never a player-writable health endpoint.
  await pool.query('UPDATE charmville_creature_vitals SET hp=1 WHERE creature_id=$1',[creatureId]);
  const results=await Promise.all([creatureVitals(pool,tokens[0],command),creatureVitals(pool,tokens[0],command)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].creatures[0].hp,11);assert.equal(results[0].oranQuantity,'2');
  await assert.rejects(creatureVitals(pool,tokens[0],{...command,revision:'1'}),/already used/);
  await assert.rejects(creatureVitals(pool,tokens[0],{...command,requestId:randomUUID()}),/changed/);
  const healed=await creatureVitals(pool,tokens[0],{...command,requestId:randomUUID(),revision:'1'});assert.equal(healed.creatures[0].hp,healed.creatures[0].maxHp);assert.equal(healed.oranQuantity,'1');
  await pool.query('UPDATE charmville_creature_vitals SET hp=0 WHERE creature_id=$1',[creatureId]);await assert.rejects(creatureVitals(pool,tokens[0],{...command,requestId:randomUUID(),revision:'2'}),/revival/);assert.equal((await creatureVitals(pool,tokens[0])).oranQuantity,'1');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
