import type {Pool,PoolClient} from "pg";
import {homeActor,requireHomeRight,type HomeRight} from "./home-access-store";
import {YardError} from "./errors";
export type WorldEntry={destination:"public"|"home";handle?:string;revision:string};
export function parseWorldEntry(raw:unknown):WorldEntry {
 const p=raw as Record<string,unknown>|null;
 if(!p || (p.destination!=="public" && p.destination!=="home") || typeof p.revision!=="string" || !/^\d{1,18}$/.test(p.revision))throw new YardError("Choose a current world destination",400);
 if(p.destination==="home" && (typeof p.handle!=="string" || !/^[a-z0-9_]{1,40}$/.test(p.handle)))throw new YardError("Choose a player's home",400);
 return {destination:p.destination,revision:p.revision,...(p.destination==="home"?{handle:p.handle as string}:{})};
}
/** Trusted server actor only. Call before an action, in its transaction, then
 * validate distance, action timing and recipe independently. Presence never
 * establishes a position, item, reward, or client-reported event as truthful. */
export async function requireWorldHome(client:PoolClient,actorId:string,ownerId:string,right:HomeRight="visit",containerId?:string) {
 const result=await client.query("SELECT home_owner_id::text AS owner FROM charmville_world_presence WHERE profile_id=$1 AND expires_at>clock_timestamp() FOR UPDATE",[actorId]);
 if(result.rows[0]?.owner!==ownerId)throw new YardError("Enter this home again before interacting",403);
 const approved=await client.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[ownerId]);
 if(!approved.rowCount)throw new YardError("Home is unavailable",403);
 await requireHomeRight(client,ownerId,actorId,right,containerId);
}
export async function worldPresence(pool:Pool,token:string,raw?:WorldEntry) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const profileId=await homeActor(client,token);
  await client.query("INSERT INTO charmville_world_presence(profile_id) VALUES($1) ON CONFLICT DO NOTHING",[profileId]);
  let row=(await client.query("SELECT home_owner_id::text AS owner,revision::text,expires_at>clock_timestamp() AS active,changed_at>clock_timestamp()-interval '1 second' AS throttled FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  let reason:string|null=null;
  if(raw) {
   const entry=parseWorldEntry(raw);
   if(entry.revision!==row.revision)throw new YardError("Your location changed. Refresh the world.",409);
   if(row.throttled)throw new YardError("Please wait a moment before traveling again",429);
   let owner:string|null=null;
   if(entry.destination==="home") {
    const result=await client.query("SELECT id::text FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'",[entry.handle]);
    if(!result.rows[0])throw new YardError("Home not found",404);
    owner=result.rows[0].id;
    await requireHomeRight(client,owner!,profileId,"visit");
   }
   await client.query("UPDATE charmville_world_presence SET home_owner_id=$2,revision=revision+1,expires_at=clock_timestamp()+interval '90 seconds',changed_at=clock_timestamp() WHERE profile_id=$1",[profileId,owner]);
   row={...row,owner,active:true};
  }else if(!row.active && row.owner!==null) {
   reason="expired";
  }else if(row.owner!==null) {
   const approved=await client.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[row.owner]);
   if(!approved.rowCount) reason="permission-revoked";
   else try {await requireHomeRight(client,row.owner,profileId,"visit");}catch(error){if(error instanceof YardError && [403,404].includes(error.status))reason="permission-revoked";else throw error;}
  }
  if(reason)await client.query("UPDATE charmville_world_presence SET home_owner_id=NULL,revision=revision+1,expires_at=clock_timestamp() WHERE profile_id=$1",[profileId]);
  const state=(await client.query(`SELECT w.home_owner_id::text AS owner,w.revision::text,w.expires_at AS "expiresAt",w.expires_at>clock_timestamp() AS active,p.handle AS "ownerHandle" FROM charmville_world_presence w LEFT JOIN plankspace_profiles p ON p.id=w.home_owner_id WHERE w.profile_id=$1`,[profileId])).rows[0];
  const peers=state.active?await client.query(`SELECT w.profile_id::text AS "profileId",p.handle FROM charmville_world_presence w JOIN plankspace_profiles p ON p.id=w.profile_id WHERE w.profile_id<>$1 AND p.moderation_status='approved' AND w.expires_at>clock_timestamp() AND w.home_owner_id IS NOT DISTINCT FROM $2::bigint AND (w.home_owner_id IS NULL OR w.home_owner_id=w.profile_id OR EXISTS(SELECT 1 FROM charmville_home_grants g WHERE g.owner_profile_id=w.home_owner_id AND g.visitor_profile_id=w.profile_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND 'visit'=ANY(g.rights))) ORDER BY p.handle LIMIT 64`,[profileId,state.owner]):{rows:[]};
  await client.query("COMMIT");
  return {profileId,regionId:state.owner?`home:${state.owner}`:"public:meadow",ownerHandle:state.ownerHandle,revision:state.revision,expiresAt:state.expiresAt.toISOString(),active:state.active,peers:peers.rows,reason};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
