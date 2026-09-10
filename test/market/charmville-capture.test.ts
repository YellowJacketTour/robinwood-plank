import {creatureRoster} from '../../lib/charmville/creature-roster';
import {syncBuiltinESMExports} from 'node:module';
import {captureCreature} from '../../lib/charmville/capture';
import crypto from 'node:crypto';
import {turnBattle} from "../../lib/charmville/turn-battle";
import {worldEncounter} from "../../lib/charmville/encounters";
import {nativeActor} from "../../lib/charmville/native-actor";
import {creatureVitals} from "../../lib/charmville/creature-vitals";
import {test,mock} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";
import {worldPresence} from "../../lib/charmville/world-presence";
test("capture finite supply, retaliation, replay and UUID ownership transfer",{skip:!process.env.CHARMVILLE_TEST_DATABASE_URL},async()=>{
 const connectionString=process.env.CHARMVILLE_TEST_DATABASE_URL!;assert.ok(["127.0.0.1","localhost"].includes(new URL(connectionString).hostname));
 const admin=new Pool({connectionString}),schema=`actor_${randomUUID().replaceAll("-","")}`;await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString,options:`-c search_path=${schema}`});
 try{
  for(const f of ["090_plankspace_native.sql","104_charmville_soil.sql","106_charmville_home_access.sql","108_charmville_world_presence.sql","109_charmville_exchange.sql","113_charmville_native_actor.sql","114_charmville_native_resources.sql","110_charmville_companions.sql","111_charmville_companion_following.sql","112_charmville_creature_roster.sql","115_charmville_creature_vitals.sql","116_charmville_encounters.sql","117_charmville_turn_combat.sql","119_charmville_test_party.sql","120_charmville_battle_events.sql","122_charmville_individual_following.sql","123_charmville_capture.sql"])await pool.query(await readFile(`deploy/inmotion/postgres/migrations/${f}`,"utf8"));
  const tokens=["a".repeat(64),"b".repeat(64)];
  for(let i=0;i<2;i++){const wallet=`0x${i+1}`.padEnd(42,String(i+1));const p=await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status) VALUES($1,$2,$2,'approved') RETURNING id",[wallet,`p${i}`]);await pool.query("INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[createHash("sha256").update(tokens[i]).digest("hex"),wallet]);await pool.query("INSERT INTO charmville_yards(profile_id) VALUES($1)",[p.rows[0].id]);await worldPresence(pool,tokens[i],{destination:"public",revision:"0"});}


  const owner=(await pool.query("SELECT id::text FROM plankspace_profiles WHERE handle='p0'")).rows[0].id;
  const creatureId=randomUUID();await pool.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,277,'Treecko','starter')",[creatureId,owner]);
  await pool.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,'oran-berry',3)",[owner]);

  await creatureVitals(pool,tokens[0]);await pool.query('INSERT INTO charmville_creature_rosters(profile_id) VALUES($1)',[owner]);await pool.query('INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,0,$2)',[owner,creatureId]);
  await nativeActor(pool,tokens[0]);await nativeActor(pool,tokens[1]);let e=await worldEncounter(pool,tokens[0]);const lifecycle=async(action:string)=>{e=await worldEncounter(pool,tokens[0],{action,requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch});};await lifecycle('claim');
  assert.equal(e.encounter.mode,'world');
  await assert.rejects(captureCreature(pool,tokens[0],{action:'provision'},true),/sandbox/);
  await pool.query('INSERT INTO charmville_local_playtest_accounts(profile_id) VALUES($1)',[owner]);
  await assert.rejects(captureCreature(pool,tokens[0],{action:'provision'}),/sandbox/);
  assert.equal((await captureCreature(pool,tokens[0],{action:'provision'},true)).balls,3);
  assert.equal((await captureCreature(pool,tokens[0],{action:'provision'},true)).balls,3);
  const command={action:'throw',requestId:randomUUID(),encounterId:e.encounter.id,revision:e.encounter.revision,actorEpoch:e.actorEpoch};
  await assert.rejects(captureCreature(pool,tokens[1],command));
  const rng=mock.method(crypto,'randomInt',((max:number)=>max===65536?65535:max-1) as typeof crypto.randomInt);syncBuiltinESMExports();
  const failed=await captureCreature(pool,tokens[0],command);assert.equal(failed.captured,false);assert.equal(failed.balls,2);assert.ok(failed.retaliation);assert.equal((await pool.query('SELECT pp FROM charmville_wild_combat')).rows[0].pp,34);
  assert.deepEqual(await captureCreature(pool,tokens[0],command),failed);
  assert.equal(failed.eventId,command.requestId);assert.deepEqual(failed.targetCell,{x:4,y:9});
  const wildBefore=(await pool.query('SELECT attack_iv,defense_iv,speed_iv,pp FROM charmville_wild_combat')).rows[0];e=await worldEncounter(pool,tokens[0]);await lifecycle('enter-turn');assert.deepEqual((await pool.query('SELECT attack_iv,defense_iv,speed_iv,pp FROM charmville_wild_combat')).rows[0],wildBefore);
  rng.mock.restore();const win=mock.method(crypto,'randomInt',(()=>0) as typeof crypto.randomInt);syncBuiltinESMExports();
  const capture={...command,requestId:randomUUID(),revision:e.encounter.revision};const pair=await Promise.all([captureCreature(pool,tokens[0],capture),captureCreature(pool,tokens[0],capture)]);assert.deepEqual(pair[0],pair[1]);const success=pair[0];assert.equal(success.captured,true);assert.equal(success.creatureId,e.encounter.id);assert.equal(success.balls,1);
  assert.deepEqual(await captureCreature(pool,tokens[0],capture),success);assert.equal((await captureCreature(pool,tokens[0],{action:'provision'},true)).balls,1);
  const transferred=(await pool.query('SELECT v.*,e.owner_profile_id::text FROM charmville_creature_entities e JOIN charmville_creature_vitals v ON v.creature_id=e.id WHERE e.id=$1',[e.encounter.id])).rows[0];assert.equal(transferred.owner_profile_id,owner);assert.equal(transferred.hp,e.encounter.hp);assert.equal(transferred.level,2);
  const roster=await creatureRoster(pool,tokens[0]);const placed=await creatureRoster(pool,tokens[0],{revision:roster.revision,slots:[creatureId,e.encounter.id,null,null,null,null]});assert.equal(placed.slots[1].acquisitionKind,'capture');const followed=await creatureRoster(pool,tokens[0],{action:'following',revision:placed.revision,creatureId:e.encounter.id,following:true});assert.equal(followed.slots[1].following,true);assert.equal((await creatureVitals(pool,tokens[0])).creatures.find(v=>v.id===e.encounter.id)?.hp,e.encounter.hp);
  const terminal=await worldEncounter(pool,tokens[0]);assert.equal(terminal.encounter.captured,true);assert.deepEqual(terminal.legalActions,[]);await assert.rejects(turnBattle(pool,tokens[0]),/Inspect/);
  await assert.rejects(captureCreature(pool,tokens[0],{...capture,requestId:randomUUID(),revision:success.revision}));
  win.mock.restore();
 }finally{mock.restoreAll();syncBuiltinESMExports();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
