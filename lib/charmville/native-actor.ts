import type {Pool} from "pg";
import manifest from "./geometry/native-adventure-d4-s63.json";
import {homeActor,requireHomeRight} from "./home-access-store";
import {spawnActor,stepActor,type ActorState} from "./native-action-domain";
import {YardError} from "./errors";
// Conservative top-left anchors for the exported 16px footprint, not native hitbox parity.
const rawBlocked=new Set(manifest.blocked), blocked=new Set<string>();
export const actorGeometry={width:manifest.width-manifest.footprint.width+1,height:manifest.height-manifest.footprint.height+1,blocked};
for(let y=0;y<actorGeometry.height;y++)for(let x=0;x<actorGeometry.width;x++)for(let dy=0;dy<manifest.footprint.height;dy++)for(let dx=0;dx<manifest.footprint.width;dx++)if(rawBlocked.has(`${x+dx},${y+dy}`))blocked.add(`${x},${y}`);
export const nativeGeometryId=manifest.id;
const policy={stepMs:100,jitterMs:20,windupMs:500,range:1,actions:[]};
export async function nativeActor(pool:Pool,token:string,raw?:unknown){
 const c=await pool.connect();try{
  await c.query("BEGIN");const profileId=await homeActor(c,token);
  const presence=(await c.query("SELECT home_owner_id::text AS owner,revision::text,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  if(!presence?.active)throw new YardError("Enter the world before moving",403);
  if(presence.owner){
   const approved=await c.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[presence.owner]);
   if(!approved.rowCount)throw new YardError("Home is unavailable",403);
   await requireHomeRight(c,presence.owner,profileId,"visit");
  }
  // Each admission currently instances this one authored layout. This does not
  // create different terrain or authorize dynamic doors, elevation or rewards.
  const regionId=presence.owner?`home:${presence.owner}`:"public:meadow";
  const now=Number((await c.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
  const row=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  let state:ActorState=row?{cell:{x:row.x,y:row.y},sequence:Number(row.sequence),regionEpoch:Number(row.region_epoch),lastMoveAt:Number(row.last_move_at),lastCheckedAt:Number(row.last_checked_at),action:null}:spawnActor(actorGeometry,manifest.spawn,0,now);
  let version=row?Number(row.version):0;
  const changed=!!row&&(row.region_id!==regionId||row.geometry_revision!==manifest.revision);
  if(changed){state=spawnActor(actorGeometry,manifest.spawn,state.regionEpoch+1,now);version++;}
  if(raw!==undefined){
   const p=raw as Record<string,unknown>|null;
   if(!p||Object.keys(p).some(k=>!["x","y","sequence","regionEpoch","presenceRevision","geometryId"].includes(k))||p.geometryId!==manifest.id)throw new YardError("Unsupported movement or map",400);
   if(p.presenceRevision!==presence.revision)throw new YardError("World admission changed. Refresh your position.",409);
   if(changed)throw new YardError("Region changed. Refresh your position.",409);
   const replay=p.sequence===state.sequence&&p.regionEpoch===state.regionEpoch&&p.x===state.cell.x&&p.y===state.cell.y;
   if(!replay){try{state=stepActor(state,{x:p.x,y:p.y,sequence:p.sequence,regionEpoch:p.regionEpoch},actorGeometry,now,policy).state;version++;}catch(e){throw new YardError(e instanceof Error?e.message:"Invalid movement",409);}}
  }
  await c.query(`INSERT INTO charmville_native_actors(profile_id,region_id,geometry_revision,region_epoch,sequence,x,y,last_move_at,last_checked_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(profile_id) DO UPDATE SET region_id=EXCLUDED.region_id,geometry_revision=EXCLUDED.geometry_revision,region_epoch=EXCLUDED.region_epoch,sequence=EXCLUDED.sequence,x=EXCLUDED.x,y=EXCLUDED.y,last_move_at=EXCLUDED.last_move_at,last_checked_at=EXCLUDED.last_checked_at,version=EXCLUDED.version`,[profileId,regionId,manifest.revision,state.regionEpoch,state.sequence,state.cell.x,state.cell.y,state.lastMoveAt,state.lastCheckedAt,version]);
  const peers=raw===undefined?(await c.query(`SELECT a.profile_id::text AS "profileId",p.handle,a.x,a.y,a.sequence::text,a.region_epoch::text AS epoch
   FROM charmville_native_actors a JOIN plankspace_profiles p ON p.id=a.profile_id JOIN charmville_world_presence w ON w.profile_id=a.profile_id
   WHERE a.profile_id<>$1 AND a.region_id=$2 AND a.geometry_revision=$3 AND p.moderation_status='approved'
   AND w.expires_at>clock_timestamp() AND w.home_owner_id IS NOT DISTINCT FROM $4::bigint
   AND (w.home_owner_id IS NULL OR w.home_owner_id=w.profile_id OR EXISTS(SELECT 1 FROM charmville_home_grants g WHERE g.owner_profile_id=w.home_owner_id AND g.visitor_profile_id=w.profile_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND 'visit'=ANY(g.rights)))
   ORDER BY a.profile_id LIMIT 16`,[profileId,regionId,manifest.revision,presence.owner])).rows.map(p=>({profileId:p.profileId,handle:p.handle,cell:{x:p.x,y:p.y},sequence:Number(p.sequence),regionEpoch:Number(p.epoch)})):undefined;
  await c.query("COMMIT");
  return {profileId,regionId,presenceRevision:presence.revision,geometryId:manifest.id,geometryRevision:manifest.revision,tilePixels:manifest.tilePixels,footprint:manifest.footprint,cell:state.cell,sequence:state.sequence,regionEpoch:state.regionEpoch,version,...(peers?{peers}:{})};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
