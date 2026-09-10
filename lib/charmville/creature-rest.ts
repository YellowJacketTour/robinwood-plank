import type {Pool} from "pg";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";
import {moveStats} from "./move-stats";
import manifest from "./geometry/native-adventure-d4-s63.json";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function creatureRest(pool:Pool,token:string,raw?:unknown){const c=await pool.connect();try{
 await c.query("BEGIN");const id=await homeActor(c,token);await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`creature-vitals:${id}`]);
 const p=(await c.query("SELECT home_owner_id::text AS owner,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
 const a=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
 const battle=(await c.query("SELECT 1 FROM charmville_encounters WHERE controller_id=$1 AND mode='turn' AND lease_until>clock_timestamp()",[id])).rowCount;
 const reason=!p?.active||p.owner!==id?"Return to your own home to rest":!a||a.region_id!==`home:${id}`||a.geometry_revision!==manifest.revision?"Refresh your home position":battle?"Leave the encounter before resting":null;
 await c.query("UPDATE charmville_creature_rest SET status='cancelled' WHERE profile_id=$1 AND status='pending' AND expires_at<=clock_timestamp()",[id]);
 let result:unknown=null;
 if(raw!==undefined){const q=raw as Record<string,unknown>|null;if(!q||!uuid.test(String(q.requestId))||!["begin","commit","cancel"].includes(String(q.phase))||Object.keys(q).some(k=>!["phase","requestId",...(q.phase==="begin"?["creatureId"]:[])].includes(k)))throw new YardError("Invalid rest request",400);
 let r=(await c.query("SELECT * FROM charmville_creature_rest WHERE profile_id=$1 AND request_id=$2 FOR UPDATE",[id,q.requestId])).rows[0];
 if(q.phase==="begin"){
  if(!uuid.test(String(q.creatureId)))throw new YardError("Choose an owned companion",400);
  if(r){if(r.creature_id!==q.creatureId)throw new YardError("Request ID already used",409);}
  else{
   if(reason)throw new YardError(reason,409);
   const v=(await c.query("SELECT v.hp,v.max_hp,b.pp,b.move_id FROM charmville_creature_entities e JOIN charmville_creature_vitals v ON v.creature_id=e.id LEFT JOIN charmville_creature_combat b ON b.creature_id=e.id WHERE e.id=$1 AND e.owner_profile_id=$2 AND e.acquisition_kind IN ('starter','local-playtest','capture') FOR UPDATE OF v",[q.creatureId,id])).rows[0];
   if(!v)throw new YardError("Choose an owned companion with health",403);const maxPp=v.move_id?moveStats(v.move_id)?.pp:undefined;
   if(v.hp===v.max_hp&&(maxPp===undefined||v.pp===maxPp))throw new YardError("This companion is already fully rested",409);
   if((await c.query("SELECT 1 FROM charmville_creature_rest WHERE profile_id=$1 AND status='pending'",[id])).rowCount)throw new YardError("Finish or cancel the current rest",409);
   r=(await c.query("INSERT INTO charmville_creature_rest(profile_id,request_id,creature_id,region_epoch,sequence,ready_at,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '10 seconds',clock_timestamp()+interval '60 seconds') RETURNING *",[id,q.requestId,q.creatureId,a.region_epoch,a.sequence])).rows[0];
  }
 }else{
  if(!r)throw new YardError("Rest not found",404);
  if(r.status==="pending"){
   if(q.phase==="cancel"){await c.query("UPDATE charmville_creature_rest SET status='cancelled' WHERE profile_id=$1 AND request_id=$2",[id,q.requestId]);r.status="cancelled";}
   else{
    if(reason||r.region_epoch!==a.region_epoch||r.sequence!==a.sequence)throw new YardError(reason??"Movement interrupted rest. Cancel and try again",409);
    if(!(await c.query("SELECT clock_timestamp()>=$1 AS ready",[r.ready_at])).rows[0].ready)throw new YardError("Rest is not finished yet",409);
    const owned=await c.query("SELECT 1 FROM charmville_creature_entities WHERE id=$1 AND owner_profile_id=$2 AND acquisition_kind IN ('starter','local-playtest','capture') FOR SHARE",[r.creature_id,id]);if(!owned.rowCount)throw new YardError("Companion ownership changed",403);
    await c.query("UPDATE charmville_creature_vitals SET hp=max_hp,revision=revision+1 WHERE creature_id=$1",[r.creature_id]);const combat=(await c.query("SELECT move_id FROM charmville_creature_combat WHERE creature_id=$1 FOR UPDATE",[r.creature_id])).rows[0];if(combat){const pp=moveStats(combat.move_id)?.pp;if(pp===undefined)throw new YardError("Unsupported move",409);await c.query("UPDATE charmville_creature_combat SET pp=$2 WHERE creature_id=$1",[r.creature_id,pp]);}
    await c.query("UPDATE charmville_creature_rest SET status='committed' WHERE profile_id=$1 AND request_id=$2",[id,q.requestId]);r.status="committed";
   }
  }else if(r.status==="cancelled"&&q.phase==="commit")throw new YardError("Rest was cancelled or expired",409);
 }
 result={requestId:q.requestId,creatureId:r.creature_id,status:r.status};
 }
 const current=(await c.query("SELECT request_id AS \"requestId\",creature_id AS \"creatureId\",ready_at AS \"readyAt\",expires_at AS \"expiresAt\" FROM charmville_creature_rest WHERE profile_id=$1 AND status='pending'",[id])).rows[0]??null;const now=(await c.query("SELECT clock_timestamp() AS now")).rows[0].now;
 const candidates=(await c.query("SELECT e.id,v.hp,v.max_hp,b.move_id,b.pp FROM charmville_creature_entities e JOIN charmville_creature_vitals v ON v.creature_id=e.id LEFT JOIN charmville_creature_combat b ON b.creature_id=e.id WHERE e.owner_profile_id=$1 AND e.acquisition_kind IN ('starter','local-playtest','capture')",[id])).rows;
 const eligibleCreatureIds=reason?[]:candidates.filter(v=>v.hp<v.max_hp||(v.move_id&&v.pp<(moveStats(v.move_id)?.pp??0))).map(v=>v.id);
 await c.query("COMMIT");return {eligible:reason===null,eligibleCreatureIds,reason,pending:current,serverNow:now.toISOString(),result};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
