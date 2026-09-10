import type {Pool} from "pg";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";
export type RosterCommand={revision:string;slots:(string|null)[]}|{action:'following';revision:string;creatureId:string;following:boolean};
export function parseRoster(raw:unknown):RosterCommand {
 const p=raw as Record<string,unknown>|null;
 if(p?.action==='following'){if(typeof p.revision!=='string'||!/^\d{1,18}$/.test(p.revision)||typeof p.creatureId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.creatureId)||typeof p.following!=='boolean')throw new YardError('Choose an owned creature and following preference',400);return {action:'following',revision:p.revision,creatureId:p.creatureId.toLowerCase(),following:p.following};}
 if(!p||typeof p.revision!=="string"||!/^\d{1,18}$/.test(p.revision)||!Array.isArray(p.slots)||p.slots.length!==6||!p.slots.every(v=>v===null||(typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v))))throw new YardError("Choose six party slots",400);
 const slots=p.slots.map(v=>typeof v==="string"?v.toLowerCase():null);const ids=slots.filter(v=>v!==null);if(new Set(ids).size!==ids.length)throw new YardError("A creature can occupy only one slot",400);
 return {revision:p.revision,slots};
}
export async function creatureRoster(pool:Pool,token:string,raw?:RosterCommand){
 const client=await pool.connect();try{
  await client.query("BEGIN");const profileId=await homeActor(client,token);
  // Compatibility import: preserve original UUID; never allocate a second starter.
  const imported=await client.query(`INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind,created_at) SELECT id,owner_profile_id,source_species_id,nickname,'starter',created_at FROM charmville_companions WHERE owner_profile_id=$1 ON CONFLICT DO NOTHING RETURNING id`,[profileId]);
  const created=await client.query("INSERT INTO charmville_creature_rosters(profile_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING profile_id",[profileId]);
  const state=(await client.query("SELECT revision::text FROM charmville_creature_rosters WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  if(created.rowCount||(imported.rowCount&&state.revision==="0"))await client.query("INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) SELECT $1,0,id FROM charmville_creature_entities WHERE owner_profile_id=$1 AND acquisition_kind='starter' AND NOT EXISTS(SELECT 1 FROM charmville_creature_slots WHERE profile_id=$1)",[profileId]);
  const old=(await client.query("SELECT slot_index,creature_id FROM charmville_creature_slots WHERE profile_id=$1 ORDER BY slot_index",[profileId])).rows;
  const slots:(string|null)[]=Array(6).fill(null);for(const row of old)slots[row.slot_index]=row.creature_id;
  if(raw){const input=parseRoster(raw);
   if('action' in input){
    const entity=(await client.query('SELECT id,following FROM charmville_creature_entities WHERE owner_profile_id=$1 AND id=$2 FOR UPDATE',[profileId,input.creatureId])).rows[0];
    if(!entity)throw new YardError('Choose only creatures you own',403);
    if(BigInt(input.revision)>BigInt(state.revision)||(entity.following!==input.following&&input.revision!==state.revision))throw new YardError('Your party changed. Refresh before changing following.',409);
    if(entity.following!==input.following){await client.query('UPDATE charmville_creature_entities SET following=$2 WHERE id=$1',[input.creatureId,input.following]);await client.query('UPDATE charmville_companions SET following=$2,revision=revision+1 WHERE id=$1 AND following<>$2',[input.creatureId,input.following]);await client.query('UPDATE charmville_creature_rosters SET revision=revision+1 WHERE profile_id=$1',[profileId]);}
   }else{const same=JSON.stringify(slots)===JSON.stringify(input.slots);
   if(BigInt(input.revision)>BigInt(state.revision)||(!same&&input.revision!==state.revision))throw new YardError("Your party changed. Refresh before rearranging.",409);
   if(!same){const ids=input.slots.filter(v=>v!==null);const owned=await client.query("SELECT id FROM charmville_creature_entities WHERE owner_profile_id=$1 AND id=ANY($2::uuid[]) FOR SHARE",[profileId,ids]);if(owned.rowCount!==ids.length)throw new YardError("Choose only creatures you own",403);
    await client.query("DELETE FROM charmville_creature_slots WHERE profile_id=$1",[profileId]);
    for(let slot=0;slot<6;slot++)if(input.slots[slot])await client.query("INSERT INTO charmville_creature_slots(profile_id,slot_index,creature_id) VALUES($1,$2,$3)",[profileId,slot,input.slots[slot]]);
    await client.query("UPDATE charmville_creature_rosters SET revision=revision+1 WHERE profile_id=$1",[profileId]);
   }
  }
  }
  const owned=(await client.query(`SELECT id,source_species_id AS "speciesId",nickname,source,acquisition_kind AS "acquisitionKind",COALESCE((to_jsonb(e)->>'following')::boolean,false) AS following FROM charmville_creature_entities e WHERE owner_profile_id=$1 ORDER BY created_at,id`,[profileId])).rows;
  const placed=(await client.query("SELECT slot_index,creature_id FROM charmville_creature_slots WHERE profile_id=$1",[profileId])).rows;
  const party=Array(6).fill(null);for(const row of placed)party[row.slot_index]=owned.find(e=>e.id===row.creature_id);
  const revision=(await client.query("SELECT revision::text FROM charmville_creature_rosters WHERE profile_id=$1",[profileId])).rows[0].revision;
  await client.query("COMMIT");return {revision,slots:party,owned};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
