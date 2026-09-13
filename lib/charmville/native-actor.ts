import type {Pool} from "pg";
import manifest from "./geometry/native-adventure-d4-s63.json";
import {homeActor,requireHomeRight} from "./home-access-store";
import {spawnActor,stepActor,type ActorState} from "./native-action-domain";
import {YardError} from "./errors";
import {mapByRevision,nativeMapGeometry,crossNativeBorder} from './native-world';
export const actorGeometry=nativeMapGeometry(manifest);
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
  let now=Number((await c.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);
  const row=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[profileId])).rows[0];
  let activeMap=row?.region_id===regionId?mapByRevision(row.geometry_revision)??manifest:manifest;
  let geometry=nativeMapGeometry(activeMap);
  let state:ActorState=row?{cell:{x:row.x,y:row.y},sequence:Number(row.sequence),regionEpoch:Number(row.region_epoch),lastMoveAt:Number(row.last_move_at),lastCheckedAt:Number(row.last_checked_at),action:null}:spawnActor(actorGeometry,manifest.spawn,0,now);
  let version=row?Number(row.version):0;
  const changed=!!row&&(row.region_id!==regionId||row.geometry_revision!==activeMap.revision);
  if(changed){state=spawnActor(actorGeometry,manifest.spawn,state.regionEpoch+1,now);version++;}
  if(raw!==undefined){
   const p=raw as Record<string,unknown>|null;
   if(!p||Object.keys(p).some(k=>!["x","y","sequence","regionEpoch","presenceRevision","geometryId","destination","waitForTurn"].includes(k))||p.geometryId!==activeMap.id||(p.waitForTurn!==undefined&&p.waitForTurn!==true))throw new YardError("Unsupported movement or map",400);
   if(p.presenceRevision!==presence.revision)throw new YardError("World admission changed. Refresh your position.",409);
   if(changed)throw new YardError("Region changed. Refresh your position.",409);
   if(p.destination!==undefined){
    if(p.sequence!==state.sequence+1||p.regionEpoch!==state.regionEpoch||p.x!==undefined||p.y!==undefined)throw new YardError('Stale travel request',409);
    try{const travel=crossNativeBorder(state,activeMap,p.destination,now);activeMap=travel.map;geometry=nativeMapGeometry(activeMap);state=travel.state;version++;}catch(e){throw new YardError(e instanceof Error?e.message:'Travel unavailable',409);}
   }else{
   const replay=p.sequence===state.sequence&&p.regionEpoch===state.regionEpoch&&p.x===state.cell.x&&p.y===state.cell.y;
   if(!replay){try{
    const intent={x:p.x,y:p.y,sequence:p.sequence,regionEpoch:p.regionEpoch};
    try{state=stepActor(state,intent,geometry,now,policy).state;}
    catch(error){
     // Validation runs before the timing check. Only a valid adjacent step may
     // wait; malformed, stale and blocked requests never enter this path.
     if(p.waitForTurn!==true||!(error instanceof Error)||error.message!=='Movement too fast')throw error;
     const diagonal=p.x!==state.cell.x&&p.y!==state.cell.y;
     const waitMs=state.lastMoveAt+Math.ceil(policy.stepMs*(diagonal?Math.SQRT2:1))-now;
     if(waitMs<=0||waitMs>200)throw error;
     await new Promise<void>(resolve=>setTimeout(resolve,waitMs));
     const timing=(await c.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now, expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1',[profileId])).rows[0];
     if(!timing?.active)throw new YardError('Enter the world before moving',403);
     await homeActor(c,token);
     if(presence.owner)await requireHomeRight(c,presence.owner,profileId,'visit');
     now=Number(timing.now);
     state=stepActor(state,intent,geometry,now,policy).state;
    }
    version++;
   }catch(e){if(e instanceof YardError)throw e;throw new YardError(e instanceof Error?e.message:"Invalid movement",409);}}
  }
   }
  // Snapshot reads retain admission checks and locks, but need no new row version.
  // First admission and map changes still persist their spawn before returning.
  if(!row||changed||raw!==undefined)await c.query(`INSERT INTO charmville_native_actors(profile_id,region_id,geometry_revision,region_epoch,sequence,x,y,last_move_at,last_checked_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(profile_id) DO UPDATE SET region_id=EXCLUDED.region_id,geometry_revision=EXCLUDED.geometry_revision,region_epoch=EXCLUDED.region_epoch,sequence=EXCLUDED.sequence,x=EXCLUDED.x,y=EXCLUDED.y,last_move_at=EXCLUDED.last_move_at,last_checked_at=EXCLUDED.last_checked_at,version=EXCLUDED.version`,[profileId,regionId,activeMap.revision,state.regionEpoch,state.sequence,state.cell.x,state.cell.y,state.lastMoveAt,state.lastCheckedAt,version]);
  const peers=raw===undefined?(await c.query(`SELECT a.profile_id::text AS "profileId",p.handle,a.x,a.y,a.sequence::text,a.region_epoch::text AS epoch
   FROM charmville_native_actors a JOIN plankspace_profiles p ON p.id=a.profile_id JOIN charmville_world_presence w ON w.profile_id=a.profile_id
   WHERE a.profile_id<>$1 AND a.region_id=$2 AND a.geometry_revision=$3 AND p.moderation_status='approved'
   AND w.expires_at>clock_timestamp() AND w.home_owner_id IS NOT DISTINCT FROM $4::bigint
   AND (w.home_owner_id IS NULL OR w.home_owner_id=w.profile_id OR EXISTS(SELECT 1 FROM charmville_home_grants g WHERE g.owner_profile_id=w.home_owner_id AND g.visitor_profile_id=w.profile_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND 'visit'=ANY(g.rights)))
   ORDER BY a.profile_id LIMIT 16`,[profileId,regionId,activeMap.revision,presence.owner])).rows.map(p=>({profileId:p.profileId,handle:p.handle,cell:{x:p.x,y:p.y},sequence:Number(p.sequence),regionEpoch:Number(p.epoch)})):undefined;
  await c.query("COMMIT");
  return {profileId,regionId,presenceRevision:presence.revision,geometryId:activeMap.id,geometryRevision:activeMap.revision,tilePixels:activeMap.tilePixels,footprint:activeMap.footprint,native:activeMap.native,pacedMovement:true,cell:state.cell,sequence:state.sequence,regionEpoch:state.regionEpoch,version,...(peers?{peers}:{})};
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
