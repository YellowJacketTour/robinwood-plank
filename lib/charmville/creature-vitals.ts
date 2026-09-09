import {createHash,randomInt} from "node:crypto";
import type {Pool} from "pg";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";
import {maxHp} from "./creature-stats";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function creatureVitals(pool:Pool,token:string,raw?:unknown){
 const c=await pool.connect();try{
  await c.query("BEGIN");const profile=await homeActor(c,token);
  // Serializes this account's use receipts without upgrading homeActor's profile lock.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`creature-vitals:${profile}`]);
  const entities=(await c.query("SELECT e.id,e.source_species_id,v.creature_id IS NULL AS missing FROM charmville_creature_entities e LEFT JOIN charmville_creature_vitals v ON v.creature_id=e.id WHERE e.owner_profile_id=$1 AND e.source='pokeemerald' ORDER BY e.id FOR SHARE OF e",[profile])).rows;
  for(const entity of entities){if(!entity.missing)continue;const iv=randomInt(32);let hp:number;try{hp=maxHp(entity.source_species_id,5,iv,0);}catch{continue;}await c.query("INSERT INTO charmville_creature_vitals(creature_id,level,hp_iv,hp_ev,hp,max_hp) VALUES($1,5,$2,0,$3,$3) ON CONFLICT DO NOTHING",[entity.id,iv,hp]);}
  let result:unknown=null;
  if(raw!==undefined){
   const q=raw as Record<string,unknown>|null;
   if(!q||q.action!=="use-oran"||!uuid.test(String(q.requestId))||!uuid.test(String(q.creatureId))||typeof q.revision!=="string"||!/^\d{1,18}$/.test(q.revision)||Object.keys(q).some(k=>!["action","requestId","creatureId","revision"].includes(k)))throw new YardError("Choose an owned creature and current health",400);
   const hash=createHash("sha256").update(JSON.stringify([q.action,q.creatureId,q.revision])).digest("hex");
   const prior=(await c.query("SELECT payload_hash,result FROM charmville_creature_use_receipts WHERE profile_id=$1 AND request_id=$2",[profile,q.requestId])).rows[0];
   if(prior){if(prior.payload_hash!==hash)throw new YardError("Request ID already used",409);result=prior.result;}
   else{
    if(!entities.some(e=>e.id===q.creatureId))throw new YardError("Choose a creature you own",403);
    const v=(await c.query("SELECT hp,max_hp,revision::text FROM charmville_creature_vitals WHERE creature_id=$1 FOR UPDATE",[q.creatureId])).rows[0];
    if(!v)throw new YardError("Health is not available for this species yet",409);
    if(v.revision!==q.revision)throw new YardError("Health changed. Refresh first",409);
    if(v.hp===0||v.hp===v.max_hp)throw new YardError(v.hp===0?"A fainted creature needs revival":"This creature is already at full health",409);
    const spent=await c.query("UPDATE charmville_stacks SET qty=qty-1 WHERE profile_id=$1 AND face_id='oran-berry' AND qty>=1 RETURNING qty",[profile]);if(!spent.rowCount)throw new YardError("You need an Oran Berry",409);
    const healed=Math.min(10,v.max_hp-v.hp);await c.query("UPDATE charmville_creature_vitals SET hp=hp+$2,revision=revision+1 WHERE creature_id=$1",[q.creatureId,healed]);
    result={requestId:q.requestId,creatureId:q.creatureId,healed};await c.query("INSERT INTO charmville_creature_use_receipts(profile_id,request_id,payload_hash,result) VALUES($1,$2,$3,$4::jsonb)",[profile,q.requestId,hash,JSON.stringify(result)]);
   }
  }
  const creatures=(await c.query("SELECT e.id,e.source_species_id AS \"speciesId\",v.level,v.hp_iv AS \"hpIv\",v.hp_ev AS \"hpEv\",v.hp,v.max_hp AS \"maxHp\",v.revision::text FROM charmville_creature_entities e JOIN charmville_creature_vitals v ON v.creature_id=e.id WHERE e.owner_profile_id=$1 ORDER BY e.id",[profile])).rows;
  const oranQuantity=(await c.query("SELECT COALESCE((SELECT qty FROM charmville_stacks WHERE profile_id=$1 AND face_id='oran-berry'),0)::text AS qty",[profile])).rows[0].qty;
  await c.query("COMMIT");return {creatures,oranQuantity,policy:"emerald-starter-level5-v1",result};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}

