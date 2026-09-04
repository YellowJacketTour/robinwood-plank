import {and,desc,eq} from "drizzle-orm";
import {getDb} from "../../../db";
import {profiles,publications} from "../../../db/schema";
import {hashJson} from "../auth/hash";
import {type Proof,verifyAndConsumeProof} from "../auth/verify";

const clean=(value:string)=>value.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24),text=(value:unknown,max:number)=>typeof value==="string"?value.trim().slice(0,max):"";

export async function GET(request:Request){
 const params=new URL(request.url).searchParams,handle=clean(params.get("handle")||""),kind=params.get("kind")==="blog"?"blog":"bulletin";
 if(!handle)return Response.json({items:[]});
 const items=await getDb().select().from(publications).where(and(eq(publications.authorHandle,handle),eq(publications.kind,kind),eq(publications.moderationStatus,"approved"))).orderBy(desc(publications.id)).limit(kind==="blog"?20:10);
 return Response.json({items});
}

export async function POST(request:Request){
 const payload=await request.json() as Proof&{ownerHandle?:string;kind?:string;title?:string;body?:string},ownerHandle=clean(payload.ownerHandle||""),kind=payload.kind==="blog"?"blog":"bulletin",title=text(payload.title,100),body=text(payload.body,5000),data={ownerHandle,kind,title,body};
 if(!title||!body)return Response.json({error:"A title and message are required"},{status:400});
 const wallet=await verifyAndConsumeProof(payload,"publication:create",`${ownerHandle}:${kind}`,await hashJson(data));if(!wallet)return Response.json({error:"Sign in to publish"},{status:403});
 const db=getDb(),[author]=await db.select({handle:profiles.handle}).from(profiles).where(and(eq(profiles.wallet,wallet),eq(profiles.moderationStatus,"approved"))).limit(1);if(!author||author.handle!==ownerHandle)return Response.json({error:"Only this profile owner can publish here"},{status:403});
 const [item]=await db.insert(publications).values({authorWallet:wallet,authorHandle:author.handle,kind,title,body}).returning();return Response.json({item},{status:201});
}

export async function DELETE(request:Request){
 const payload=await request.json() as Proof&{id?:number},id=Number(payload.id),data={id};if(!Number.isInteger(id))return Response.json({error:"Publication required"},{status:400});
 const wallet=await verifyAndConsumeProof(payload,"publication:delete",String(id),await hashJson(data));if(!wallet)return Response.json({error:"Sign in to delete"},{status:403});
 const removed=await getDb().delete(publications).where(and(eq(publications.id,id),eq(publications.authorWallet,wallet))).returning({id:publications.id});return removed.length?Response.json({deleted:true}):Response.json({error:"Publication not found"},{status:404});
}
