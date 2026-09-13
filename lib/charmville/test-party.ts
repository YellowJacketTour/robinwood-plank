import {maxHp} from "./creature-stats";
import {randomUUID,randomInt} from "node:crypto";
import type {Pool} from "pg";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";
const species=[277,280,283,25,133,286],names=["Treecko","Torchic","Mudkip","Pikachu","Eevee","Poochyena"];
/** Caller must enforce localPlaytestRequestAllowed; trusted marker also mandatory. */
export async function testParty(pool:Pool,token:string,provision=false){const c=await pool.connect();try{
 await c.query("BEGIN");const id=await homeActor(c,token);
 const marker=(await c.query("SELECT 1 FROM charmville_local_playtest_accounts WHERE profile_id=$1 FOR UPDATE",[id])).rowCount;
 if(!marker){if(provision)throw new YardError("Only a newly created local sandbox account can receive this party",403);await c.query("COMMIT");return {eligible:false,granted:false};}
 const prior=(await c.query("SELECT 1 FROM charmville_test_party_grants WHERE profile_id=$1",[id])).rowCount;
 if(provision&&!prior){
  await c.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind,created_at) SELECT id,owner_profile_id,source_species_id,nickname,'starter',created_at FROM charmville_companions WHERE owner_profile_id=$1 ON CONFLICT DO NOTHING",[id]);
  await c.query("INSERT INTO charmville_creature_rosters(profile_id) VALUES($1) ON CONFLICT DO NOTHING",[id]);
  const roster=(await c.query("SELECT revision FROM charmville_creature_rosters WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
  const owned=(await c.query("SELECT id,source_species_id,acquisition_kind FROM charmville_creature_entities WHERE owner_profile_id=$1",[id])).rows;
  const placed=(await c.query("SELECT creature_id FROM charmville_creature_slots WHERE profile_id=$1",[id])).rows;
  if(owned.length===0)throw new YardError("Choose your starter before provisioning the test party",409);
  if(Number(roster.revision)>0||owned.length>1||owned.some(r=>r.acquisition_kind!=="starter")||placed.length>1)throw new YardError("This account already has a customized party",409);
  const ids=[];for(let i=0;i<species.length;i++){const existing=owned.find(r=>r.source_species_id===species[i]);const entity=existing?.id??randomUUID();if(!existing)await c.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,$3,$4,'local-playtest')",[entity,id,species[i],names[i]]);if(species[i]===25){const iv=randomInt(32),hp=maxHp(25,11,iv,0);await c.query("INSERT INTO charmville_creature_vitals(creature_id,level,hp_iv,hp_ev,hp,max_hp) VALUES($1,11,$2,0,$3,$3) ON CONFLICT DO NOTHING",[entity,iv,hp]);}ids.push(entity);}
  await c.query("DELETE FROM charmville_creature_slots WHERE profile_id=$1",[id]);for(let slot=0;slot<6;slot++)await c.query("INSERT INTO charmville_creature_slots VALUES($1,$2,$3)",[id,slot,ids[slot]]);
  await c.query("UPDATE charmville_creature_rosters SET revision=revision+1 WHERE profile_id=$1",[id]);await c.query("INSERT INTO charmville_test_party_grants(profile_id) VALUES($1)",[id]);
 }
 await c.query("COMMIT");return {eligible:true,granted:!!prior||provision};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}


