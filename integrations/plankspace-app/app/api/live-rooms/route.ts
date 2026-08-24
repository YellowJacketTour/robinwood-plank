import {and,desc,eq,sql} from "drizzle-orm";
import {getDb} from "../../../db";
import {liveRoomMembers,liveRooms,profiles} from "../../../db/schema";
import {hashJson} from "../auth/hash";
import {type Proof,verifyAndConsumeProof} from "../auth/verify";

const clean=(value:string)=>value.toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,48),text=(value:unknown,max:number)=>typeof value==="string"?value.trim().slice(0,max):"";
async function directory(){const db=getDb();return db.select({slug:liveRooms.slug,title:liveRooms.title,description:liveRooms.description,hostHandle:liveRooms.hostHandle,createdAt:liveRooms.createdAt,listeners:sql<number>`count(${liveRoomMembers.id}) filter (where ${liveRoomMembers.active}=true)`,speakers:sql<number>`count(${liveRoomMembers.id}) filter (where ${liveRoomMembers.active}=true and ${liveRoomMembers.role} in ('host','speaker'))`}).from(liveRooms).leftJoin(liveRoomMembers,eq(liveRooms.slug,liveRoomMembers.roomSlug)).where(eq(liveRooms.status,"live")).groupBy(liveRooms.id).orderBy(desc(liveRooms.id)).limit(30)}
export async function GET(request:Request){const slug=clean(new URL(request.url).searchParams.get("slug")||"");if(!slug)return Response.json({rooms:await directory()});const db=getDb(),[room]=await db.select().from(liveRooms).where(eq(liveRooms.slug,slug)).limit(1);if(!room)return Response.json({error:"Lounge not found"},{status:404});const members=await db.select({handle:liveRoomMembers.handle,role:liveRoomMembers.role,micStatus:liveRoomMembers.micStatus,active:liveRoomMembers.active,avatarUrl:profiles.avatarUrl}).from(liveRoomMembers).leftJoin(profiles,eq(liveRoomMembers.wallet,profiles.wallet)).where(and(eq(liveRoomMembers.roomSlug,slug),eq(liveRoomMembers.active,true))).orderBy(liveRoomMembers.id);return Response.json({room,members:members.map(member=>({...member,avatarUrl:member.avatarUrl?`/api/avatar?handle=${member.handle}`:""}))})}

export async function POST(request:Request){
 const payload=await request.json() as Proof&{action?:string;slug?:string;title?:string;description?:string;targetHandle?:string},action=payload.action||"",slug=clean(payload.slug||payload.title||""),targetHandle=clean(payload.targetHandle||""),data={action,slug,title:text(payload.title,80),description:text(payload.description,240),targetHandle};
 const wallet=await verifyAndConsumeProof(payload,"live-room:manage",slug,await hashJson(data));if(!wallet)return Response.json({error:"Sign in to use Woodstock Live"},{status:403});
 const db=getDb(),[actor]=await db.select({handle:profiles.handle}).from(profiles).where(and(eq(profiles.wallet,wallet),eq(profiles.moderationStatus,"approved"))).limit(1);if(!actor)return Response.json({error:"Approved profile required"},{status:403});
 if(action==="create"){if(slug.length<3||!data.title)return Response.json({error:"Lounge title required"},{status:400});const jitsiRoom=`plankspace-${slug}-${crypto.randomUUID().slice(0,8)}`;try{const [room]=await db.insert(liveRooms).values({slug,title:data.title,description:data.description,hostWallet:wallet,hostHandle:actor.handle,jitsiRoom}).returning();await db.insert(liveRoomMembers).values({roomSlug:slug,wallet,handle:actor.handle,role:"host",micStatus:"approved"});return Response.json({room},{status:201})}catch{return Response.json({error:"That lounge name is already in use"},{status:409})}}
 const [room]=await db.select().from(liveRooms).where(and(eq(liveRooms.slug,slug),eq(liveRooms.status,"live"))).limit(1);if(!room)return Response.json({error:"Lounge not found"},{status:404});
 const isHost=room.hostWallet===wallet;
 if(action==="join"){await db.insert(liveRoomMembers).values({roomSlug:slug,wallet,handle:actor.handle}).onConflictDoUpdate({target:[liveRoomMembers.roomSlug,liveRoomMembers.wallet],set:{handle:actor.handle,active:true,updatedAt:new Date().toISOString()}});return Response.json({joined:true,role:isHost?"host":"listener"})}
 if(action==="request-mic"){await db.update(liveRoomMembers).set({micStatus:"requested",updatedAt:new Date().toISOString()}).where(and(eq(liveRoomMembers.roomSlug,slug),eq(liveRoomMembers.wallet,wallet),eq(liveRoomMembers.active,true)));return Response.json({requested:true})}
 if(action==="leave"){await db.update(liveRoomMembers).set({active:false,updatedAt:new Date().toISOString()}).where(and(eq(liveRoomMembers.roomSlug,slug),eq(liveRoomMembers.wallet,wallet)));return Response.json({left:true})}
 if(!isHost)return Response.json({error:"Only the host can manage speakers"},{status:403});
 if(action==="end"){await db.update(liveRooms).set({status:"ended",endedAt:new Date().toISOString()}).where(eq(liveRooms.slug,slug));await db.update(liveRoomMembers).set({active:false}).where(eq(liveRoomMembers.roomSlug,slug));return Response.json({ended:true})}
 const [target]=await db.select().from(liveRoomMembers).where(and(eq(liveRoomMembers.roomSlug,slug),eq(liveRoomMembers.handle,targetHandle))).limit(1);if(!target||target.role==="host")return Response.json({error:"Listener not found"},{status:404});
 if(action==="approve-mic")await db.update(liveRoomMembers).set({role:"speaker",micStatus:"approved",updatedAt:new Date().toISOString()}).where(eq(liveRoomMembers.id,target.id));
 else if(action==="demote")await db.update(liveRoomMembers).set({role:"listener",micStatus:"idle",updatedAt:new Date().toISOString()}).where(eq(liveRoomMembers.id,target.id));
 else if(action==="remove")await db.update(liveRoomMembers).set({active:false,updatedAt:new Date().toISOString()}).where(eq(liveRoomMembers.id,target.id));
 else return Response.json({error:"Unknown lounge action"},{status:400});
 return Response.json({updated:true});
}
