import {createHash} from "node:crypto";
import type {Pool} from "pg";
import {homeActor,requireHomeRight} from "./home-access-store";
import {YardError} from "./errors";
import manifest from "./geometry/native-adventure-d4-s63.json";
const face="oran-berry", xs=[3,7,11];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function nativeResources(pool:Pool,token:string,raw?:unknown){
 const c=await pool.connect();try{
  await c.query("BEGIN");const id=await homeActor(c,token);
  const p=(await c.query("SELECT home_owner_id::text AS owner,expires_at>clock_timestamp() AS active FROM charmville_world_presence WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
  if(!p?.active)throw new YardError("Enter the world first",403);
  if(p.owner){if(!(await c.query("SELECT 1 FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved'",[p.owner])).rowCount)throw new YardError("Home unavailable",403);await requireHomeRight(c,p.owner,id,"visit");}
  const region=p.owner?`home:${p.owner}`:"public:meadow";
  const actor=(await c.query("SELECT * FROM charmville_native_actors WHERE profile_id=$1 FOR UPDATE",[id])).rows[0];
  if(!actor||actor.region_id!==region||actor.geometry_revision!==manifest.revision)throw new YardError("Refresh your world position",409);
  await c.query("INSERT INTO charmville_yards(profile_id,grain) VALUES($1,0) ON CONFLICT DO NOTHING",[id]);
  const grant=await c.query("INSERT INTO charmville_native_seed_grants(profile_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING profile_id",[id]);
  if(grant.rowCount)await c.query("INSERT INTO charmville_seeds(profile_id,face_id,qty) VALUES($1,$2,3) ON CONFLICT(profile_id,face_id) DO UPDATE SET qty=charmville_seeds.qty+3",[id,face]);
  for(let b=0;b<3;b++)await c.query("INSERT INTO charmville_native_resources(region_id,bed_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[region,b]);
  let result:unknown=null;
  if(raw!==undefined){
   const q=raw as Record<string,unknown>|null;
   if(!q||!uuid.test(String(q.requestId))||!["begin","commit","cancel"].includes(String(q.phase)))throw new YardError("Invalid action",400);
   const existing=(await c.query("SELECT * FROM charmville_native_actions WHERE profile_id=$1 AND request_id=$2 FOR UPDATE",[id,q.requestId])).rows[0];
   if(q.phase==="begin"){
    if(Object.keys(q).some(k=>!["phase","requestId","bedId","kind","resourceRevision","regionEpoch","sequence"].includes(k))||!Number.isInteger(q.bedId)||Number(q.bedId)<0||Number(q.bedId)>2||!["till","plant","water","harvest"].includes(String(q.kind))||typeof q.resourceRevision!=="string"||!/^\d{1,18}$/.test(q.resourceRevision))throw new YardError("Choose a current bed action",400);
    const hash=createHash("sha256").update(JSON.stringify([region,q.bedId,q.kind,q.resourceRevision,q.regionEpoch,q.sequence])).digest("hex");
    if(existing){if(existing.payload_hash!==hash)throw new YardError("Action ID already used",409);result=existing.result??{requestId:q.requestId,status:existing.status,contactAt:existing.contact_at.toISOString(),expiresAt:existing.expires_at.toISOString()};}
    else{
     if(q.regionEpoch!==Number(actor.region_epoch)||q.sequence!==Number(actor.sequence))throw new YardError("Your position changed",409);
     const bed=(await c.query("SELECT *,ready_at<=clock_timestamp() AS ripe FROM charmville_native_resources WHERE region_id=$1 AND bed_id=$2 FOR UPDATE",[region,q.bedId])).rows[0];
     if(q.resourceRevision!==String(bed.revision))throw new YardError("This bed changed",409);
     await validate(String(q.kind),Number(q.bedId),bed);
     await c.query("UPDATE charmville_native_actions SET status='cancelled' WHERE profile_id=$1 AND status='pending' AND expires_at<=clock_timestamp()",[id]);
     if((await c.query("SELECT 1 FROM charmville_native_actions WHERE profile_id=$1 AND status='pending'",[id])).rowCount)throw new YardError("Finish or cancel your current action",409);
     const action=(await c.query("INSERT INTO charmville_native_actions(profile_id,request_id,payload_hash,region_id,bed_id,kind,resource_revision,region_epoch,sequence,contact_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '466 milliseconds',clock_timestamp()+interval '10 seconds') RETURNING contact_at,expires_at",[id,q.requestId,hash,region,q.bedId,q.kind,q.resourceRevision,q.regionEpoch,q.sequence])).rows[0];
     result={requestId:q.requestId,status:"pending",contactAt:action.contact_at.toISOString(),expiresAt:action.expires_at.toISOString()};
    }
   }else{
    if(Object.keys(q).some(k=>!["phase","requestId"].includes(k))||!existing)throw new YardError("Action not found",404);
    if(existing.status==="committed")result=existing.result;
    else if(q.phase==="cancel"){await c.query("UPDATE charmville_native_actions SET status='cancelled' WHERE profile_id=$1 AND request_id=$2",[id,q.requestId]);result={requestId:q.requestId,status:"cancelled"};}
    else{
     const timing=(await c.query("SELECT clock_timestamp()>=$1 AS contact,clock_timestamp()<$2 AS live",[existing.contact_at,existing.expires_at])).rows[0];
     if(existing.status!=="pending"||!timing.live)throw new YardError("Action expired or cancelled",409);
     if(!timing.contact)throw new YardError("Action has not reached contact",409);
     if(existing.region_id!==region||existing.region_epoch!==actor.region_epoch||existing.sequence!==actor.sequence)throw new YardError("Movement interrupted this action",409);
     const bed=(await c.query("SELECT *,ready_at<=clock_timestamp() AS ripe FROM charmville_native_resources WHERE region_id=$1 AND bed_id=$2 FOR UPDATE",[region,existing.bed_id])).rows[0];
     if(bed.revision!==existing.resource_revision)throw new YardError("This bed changed",409);
     await validate(existing.kind,existing.bed_id,bed);
     if(existing.kind==="plant"){
      const spent=await c.query("UPDATE charmville_seeds SET qty=qty-1 WHERE profile_id=$1 AND face_id=$2 AND qty>=1 RETURNING qty",[id,face]);if(!spent.rowCount)throw new YardError("You need an Oran Berry seed",409);
     }
     if(existing.kind==="harvest")for(const table of ["charmville_stacks","charmville_seeds"])await c.query(`INSERT INTO ${table}(profile_id,face_id,qty) VALUES($1,$2,1) ON CONFLICT(profile_id,face_id) DO UPDATE SET qty=${table}.qty+1`,[id,face]);
     const stage=existing.kind==="till"||existing.kind==="harvest"?1:existing.kind==="plant"?2:3;
     await c.query("UPDATE charmville_native_resources SET stage=$3,revision=revision+1,planter_id=CASE WHEN $4='plant' THEN $5::bigint WHEN $4='harvest' THEN NULL ELSE planter_id END,ready_at=CASE WHEN $4='water' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END WHERE region_id=$1 AND bed_id=$2",[region,existing.bed_id,stage,existing.kind,id]);
     result={requestId:q.requestId,status:"committed",kind:existing.kind,bedId:existing.bed_id,yield:existing.kind==="harvest"?{face,quantity:1,seedQuantity:1}:null};
     await c.query("UPDATE charmville_native_actions SET status='committed',result=$3::jsonb WHERE profile_id=$1 AND request_id=$2",[id,q.requestId,JSON.stringify(result)]);
    }
   }
  }
  const beds=(await c.query("SELECT bed_id AS id,CASE WHEN stage=3 AND ready_at<=clock_timestamp() THEN 4 ELSE stage END AS stage,revision::text,ready_at AS \"readyAt\",planter_id::text AS \"planterId\" FROM charmville_native_resources WHERE region_id=$1 ORDER BY bed_id",[region])).rows;
  const balances=(await c.query("SELECT COALESCE((SELECT qty FROM charmville_seeds WHERE profile_id=$1 AND face_id=$2),0)::text AS seeds,COALESCE((SELECT qty FROM charmville_stacks WHERE profile_id=$1 AND face_id=$2),0)::text AS produce",[id,face])).rows[0];
  const serverNow=(await c.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
  await c.query("COMMIT");return {regionId:region,beds,seedFace:face,...balances,result,serverNow};
  async function validate(kind:string,bedId:number,bed:{stage:number;ripe:boolean;planter_id:string|null}){
   const dx=Math.abs(actor.x-xs[bedId]),dy=Math.abs(actor.y-11);
   if(dx*dx+dy*dy>6.25||Math.min(dx,dy)>1)throw new YardError("Move closer to this bed",409);
   if(p.owner&&p.owner!==id){if(kind!=="water")throw new YardError("Only the owner can work this bed",403);await requireHomeRight(c,p.owner,id,"help");}
   if(kind==="harvest"&&bed.planter_id!==id)throw new YardError("Only the planter can harvest",403);
   const expected={till:0,plant:1,water:2,harvest:3}[kind];if(bed.stage!==expected||kind==="harvest"&&!bed.ripe)throw new YardError("This bed is not ready for that action",409);
  }
 }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
