import {habitatRefresh} from './habitat';
import {assistAvailable} from "./battle-assist";
import {encounterProjection} from "./encounter-projection";
import {createHash,randomInt,randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {homeActor,requireHomeRight} from "./home-access-store";
import {maxHp} from "./creature-stats";
import {actorGeometry} from "./native-actor";
import manifest from "./geometry/native-adventure-d4-s63.json";
import {YardError} from "./errors";
const cell={x:4,y:9},speciesId=286; // Authored placement, not an Emerald habitat claim.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function worldEncounter(pool:Pool,token:string,raw?:unknown){
 const c=await pool.connect();try{
  await c.query("BEGIN");const profileId=await homeActor(c,token);
  const presence=(await c.query("SELECT home_owner_id::text AS owner,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  if(!presence?.active)throw new YardError("Enter the world first",403);
  if(presence.owner){if(!(await c.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[presence.owner])).rowCount)throw new YardError("Home unavailable",403);await requireHomeRight(c,presence.owner,profileId,"visit");}
  const region=presence.owner?`home:${presence.owner}`:"public:meadow";
  const actor=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  if(!actor||actor.region_id!==region||actor.geometry_revision!==manifest.revision||actorGeometry.blocked.has(`${cell.x},${cell.y}`))throw new YardError("Refresh your supported world position",409);
  const iv=randomInt(32),hp=maxHp(speciesId,2,iv,0);
  await c.query("INSERT INTO charmville_encounters(id,region_id,geometry_revision,species_id,level,hp_iv,hp,max_hp) VALUES($1,$2,$3,$4,2,$5,$6,$6) ON CONFLICT(region_id) DO NOTHING",[randomUUID(),region,manifest.revision,speciesId,iv,hp]);
  const habitat=await habitatRefresh(c,region,manifest.revision);
  let e=(await c.query("SELECT * FROM charmville_encounters WHERE region_id=$1 FOR UPDATE",[region])).rows[0];
  if(e.geometry_revision!==manifest.revision)throw new YardError("Encounter map revision unavailable",409);
  if(e.controller_id){
   const valid=(await c.query(`SELECT 1 FROM charmville_world_presence w JOIN plankspace_profiles p ON p.id=w.profile_id WHERE w.profile_id=$1 AND p.moderation_status='approved' AND w.expires_at>clock_timestamp() AND $2::timestamptz>clock_timestamp() AND w.home_owner_id IS NOT DISTINCT FROM $3::bigint AND (w.home_owner_id IS NULL OR w.home_owner_id=w.profile_id OR EXISTS(SELECT 1 FROM charmville_home_grants g WHERE g.owner_profile_id=w.home_owner_id AND g.visitor_profile_id=w.profile_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND 'visit'=ANY(g.rights)))`,[e.controller_id,e.lease_until,presence.owner])).rowCount;
   if(!valid)e=(await c.query("UPDATE charmville_encounters SET controller_id=NULL,lease_until=NULL,mode='world',revision=revision+1 WHERE id=$1 RETURNING *",[e.id])).rows[0];
  }
  const inRange=Math.hypot(actor.x-cell.x,actor.y-cell.y)<=2.5;
  if(raw!==undefined){
   const q=raw as Record<string,unknown>|null;
   if(!q||!uuid.test(String(q.requestId))||!uuid.test(String(q.encounterId))||typeof q.revision!=="string"||!/^\d{1,18}$/.test(q.revision)||!["claim","enter-turn","return-world","release"].includes(String(q.action))||Object.keys(q).some(k=>!["requestId","encounterId","revision","actorEpoch","action"].includes(k)))throw new YardError("Invalid encounter action",400);
   const hash=createHash("sha256").update(JSON.stringify([q.encounterId,q.revision,q.actorEpoch,q.action])).digest("hex");
   const prior=(await c.query("SELECT payload_hash FROM charmville_encounter_receipts WHERE profile_id=$1 AND request_id=$2",[profileId,q.requestId])).rows[0];
   if(prior){if(prior.payload_hash!==hash)throw new YardError("Request ID already used",409);}
   else{
    if(q.encounterId!==e.id||q.revision!==String(e.revision)||q.actorEpoch!==Number(actor.region_epoch))throw new YardError("Encounter changed. Refresh first",409);
    if(e.captured||e.hp===0)throw new YardError("This encounter has ended",409);
    // Leaving range must not strand a reservation and block nearby players.
    // Release still requires current revision, actor epoch and controller ownership.
    if(!inRange&&q.action!=="release")throw new YardError("Move closer to the creature",409);
    if(q.action==="claim"){if(e.controller_id)throw new YardError(String(e.controller_id)===profileId?"This creature is already approached":"Another player is inspecting this creature",409);}
    else if(String(e.controller_id)!==profileId)throw new YardError("Approach this creature first",403);
    if(q.action==="enter-turn"&&e.mode!=="world"||q.action==="return-world"&&e.mode!=="turn")throw new YardError("Encounter mode changed",409);
    e=(await c.query("UPDATE charmville_encounters SET controller_id=CASE WHEN $2='release' THEN NULL ELSE $3::bigint END,lease_until=CASE WHEN $2='release' THEN NULL ELSE clock_timestamp()+interval '90 seconds' END,mode=CASE WHEN $2='enter-turn' THEN 'turn' ELSE 'world' END,revision=revision+1 WHERE id=$1 RETURNING *",[e.id,q.action,profileId])).rows[0];
    if((await c.query("SELECT to_regclass('charmville_battle_assists') AS present")).rows[0].present)await c.query("DELETE FROM charmville_battle_assists WHERE encounter_id=$1",[e.id]);
    // Preserve compatibility with installations before the additive rest table.
    if(q.action==="enter-turn"&&(await c.query("SELECT to_regclass('charmville_creature_rest') AS table_name")).rows[0].table_name)await c.query("UPDATE charmville_creature_rest SET status='cancelled' WHERE profile_id=$1 AND status='pending'",[profileId]);
    await c.query("INSERT INTO charmville_encounter_receipts(profile_id,request_id,payload_hash) VALUES($1,$2,$3)",[profileId,q.requestId,hash]);
   }
  }
  const owned=String(e.controller_id)===profileId;
  const legalActions=e.captured||e.hp===0?[]:owned?[...(inRange?[e.mode==="world"?"enter-turn":"return-world"]:[]),"release"]:inRange&&!e.controller_id?["claim"]:[];
  const canAssist=!e.captured&&inRange&&e.mode==="turn"&&await assistAvailable(c,e.id,profileId,e.controller_id?String(e.controller_id):null);
  const projection=await encounterProjection(c,e.id,region,manifest.revision,presence.owner,profileId);
  await c.query("COMMIT");return {habitat,...projection,canAssist,profileId,actorEpoch:Number(actor.region_epoch),inRange,legalActions,encounter:{captured:!!e.captured,id:e.id,speciesId:e.species_id,name:"Poochyena",cell,level:e.level,hp:e.hp,maxHp:e.max_hp,statuses:e.statuses,mode:e.mode,controllerId:e.controller_id?String(e.controller_id):null,leaseUntil:e.lease_until?.toISOString()??null,revision:String(e.revision)}};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
