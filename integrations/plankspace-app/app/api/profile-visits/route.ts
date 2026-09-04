import {and,desc,eq,sql} from "drizzle-orm";
import {getDb} from "../../../db";
import {profileVisits,profiles} from "../../../db/schema";
import {type Proof,verifyAndConsumeProof} from "../auth/verify";

const clean=(value:string)=>value.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24);

export async function GET(request:Request){
 const handle=clean(new URL(request.url).searchParams.get("handle")||"");
 if(!handle)return Response.json({visitors:[]});
 const db=getDb(),rows=await db.select({handle:profileVisits.visitorHandle,visitedAt:profileVisits.visitedAt,displayName:profiles.displayName,avatarUrl:profiles.avatarUrl}).from(profileVisits).innerJoin(profiles,eq(profileVisits.visitorWallet,profiles.wallet)).where(and(eq(profileVisits.profileHandle,handle),eq(profiles.moderationStatus,"approved"))).orderBy(desc(profileVisits.visitedAt)).limit(12);
 return Response.json({visitors:rows.map(row=>({...row,avatarUrl:row.avatarUrl?`/api/avatar?handle=${row.handle}`:""}))});
}

export async function POST(request:Request){
 const payload=await request.json() as Proof&{handle?:string},handle=clean(payload.handle||"");
 if(!handle)return Response.json({error:"Profile required"},{status:400});
 const db=getDb(),[target]=await db.update(profiles).set({viewCount:sql`${profiles.viewCount} + 1`}).where(and(eq(profiles.handle,handle),eq(profiles.moderationStatus,"approved"))).returning({viewCount:profiles.viewCount});
 if(!target)return Response.json({error:"Profile not found"},{status:404});
 const wallet=await verifyAndConsumeProof(payload,"profile:visit",handle,"");
 if(wallet){const [visitor]=await db.select({handle:profiles.handle}).from(profiles).where(and(eq(profiles.wallet,wallet),eq(profiles.moderationStatus,"approved"))).limit(1);if(visitor&&visitor.handle!==handle)await db.insert(profileVisits).values({profileHandle:handle,visitorWallet:wallet,visitorHandle:visitor.handle}).onConflictDoUpdate({target:[profileVisits.profileHandle,profileVisits.visitorWallet],set:{visitorHandle:visitor.handle,visitedAt:new Date().toISOString()}})}
 return Response.json({viewCount:target.viewCount});
}
