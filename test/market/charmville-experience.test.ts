import {turnBattle} from '../../lib/charmville/turn-battle';
import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';import {mock} from 'node:test';
import {experienceAtLevel,experienceLevel} from '../../lib/charmville/experience';
import {awardDefeat} from '../../lib/charmville/defeat-experience';
import {worldEncounter} from "../../lib/charmville/encounters";
import {nativeActor} from "../../lib/charmville/native-actor";
import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("victory XP settles once and preserves HP deficit across levels",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","120_charmville_battle_events.sql","125_charmville_experience.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  await creatureVitals(pool,tokens[0]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[owner]);await pool.query('INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,0,$2)',[owner,creatureId]);
  await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);let e=await worldEncounter(pool,tokens[0]);const lifecycle=async(action:string)=>{e=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch});};await lifecycle('claim');await lifecycle('enter-turn');
  await creatureVitals(pool,tokens[0]);await pool.query('UPDATE charmville_encounters SET hp=1 WHERE id=$1',[e.encounter.id]);
  await pool.query('UPDATE charmville_creature_vitals SET hp=max_hp-3 WHERE creature_id=$1',[creatureId]);
  const initial=await turnBattle(pool,tokens[0]);const rng=mock.method(crypto,'randomInt',(()=>0) as typeof crypto.randomInt);syncBuiltinESMExports();const command={action:'attack',requestId:randomUUID(),encounterId:e.encounter.id,revision:initial.revision,actorEpoch:e.actorEpoch,creatureId,moveId:1};const won=await turnBattle(pool,tokens[0],command);assert.deepEqual((await turnBattle(pool,tokens[0],command)).result,won.result);rng.mock.restore();syncBuiltinESMExports();
  const c=await pool.connect();try{await c.query('BEGIN');const first=await awardDefeat(c,e.encounter.id,creatureId,false);assert.equal(first.xpGained,Math.floor(55*2/7));assert.deepEqual(await awardDefeat(c,e.encounter.id,creatureId,false),first);await c.query('COMMIT');}finally{c.release();}
  const v=(await creatureVitals(pool,tokens[0])).creatures[0];assert.equal(v.maxHp-v.hp,3);assert.equal(v.experience,experienceAtLevel(277,5)+15);
  // Isolated fixture moves XP near a threshold, never a client mutation path.
  const c2=await pool.connect();try{await c2.query('BEGIN');await c2.query('DELETE FROM charmville_defeat_awards WHERE encounter_id=$1',[e.encounter.id]);await c2.query('UPDATE charmville_creature_experience SET xp=$2 WHERE creature_id=$1',[creatureId,experienceAtLevel(277,6)-1]);const leveled=await awardDefeat(c2,e.encounter.id,creatureId,false);assert.equal(leveled.level,6);await c2.query('COMMIT');}finally{c2.release();}
  const after=(await creatureVitals(pool,tokens[0])).creatures[0];assert.equal(after.maxHp-after.hp,3);assert.equal(after.hpIv,v.hpIv);
 }finally{mock.restoreAll();syncBuiltinESMExports();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
test('growth curves through100 and multi-level lookup retain source integer boundaries',()=>{assert.equal(experienceAtLevel(277,100),1059860);assert.equal(experienceAtLevel(25,100),1000000);assert.equal(experienceLevel(277,experienceAtLevel(277,25)),25);assert.equal(experienceLevel(277,99999999),100);for(const id of [277,25,133])for(let n=2;n<=100;n++)assert.ok(experienceAtLevel(id,n)>experienceAtLevel(id,n-1));});
test('all six source growth families preserve nested integer divisions',()=>{assert.equal(experienceAtLevel(301,100),600000);assert.equal(experienceAtLevel(306,100),1640000);assert.equal(experienceAtLevel(35,100),800000);assert.equal(experienceAtLevel(58,100),1250000);assert.equal(experienceAtLevel(301,69),Math.floor(Math.floor((1911-690)/3)*69**3/500));assert.equal(experienceAtLevel(306,13),Math.floor((Math.floor(14/3)+24)*13**3/50));});
