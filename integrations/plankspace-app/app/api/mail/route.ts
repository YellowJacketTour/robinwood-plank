import {and,desc,eq,isNull,or} from "drizzle-orm";
import {getDb} from "../../../db";
import {boardMessages,notifications,profileRelations,profiles} from "../../../db/schema";
import {hashJson} from "../auth/hash";
import {type Proof,verifyAndConsumeProof} from "../auth/verify";
const clean=(v:string)=>v.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24),text=(v:unknown,n:number)=>typeof v==="string"?v.trim().slice(0,n):"";
async function authorize(p:Proof,action:string,resource:string,data:unknown){return verifyAndConsumeProof(p,action,resource,await hashJson(data))}
export async function POST(request:Request){
 const p=await request.json() as Proof&{action?:string;recipientHandle?:string;subject?:string;body?:string};
 if(p.action==="list"){
  const data={action:"list"},wallet=await authorize(p,"mail:list","inbox",data);if(!wallet)return Response.json({error:"Sign to open Board Mail"},{status:403});
  const db=getDb(),messages=await db.select().from(boardMessages).where(or(eq(boardMessages.recipientWallet,wallet),eq(boardMessages.senderWallet,wallet))).orderBy(desc(boardMessages.id)).limit(100);
  await db.update(boardMessages).set({readAt:new Date().toISOString()}).where(and(eq(boardMessages.recipientWallet,wallet),isNull(boardMessages.readAt)));
  return Response.json({messages:messages.filter(m=>m.recipientWallet===wallet?!m.deletedByRecipient:!m.deletedBySender)});
 }
 if(p.action!=="send")return Response.json({error:"Invalid mail action"},{status:400});
 const recipientHandle=clean(p.recipientHandle||""),subject=text(p.subject,80)||"Board Mail",body=text(p.body,1000),data={recipientHandle,subject,body},wallet=await authorize(p,"mail:send",recipientHandle,data);if(!wallet||!body)return Response.json({error:"Sign a message with 1–1000 characters"},{status:403});
 const db=getDb(),[sender]=await db.select({handle:profiles.handle}).from(profiles).where(and(eq(profiles.wallet,wallet),eq(profiles.moderationStatus,"approved"))).limit(1),[recipient]=await db.select({wallet:profiles.wallet}).from(profiles).where(and(eq(profiles.handle,recipientHandle),eq(profiles.moderationStatus,"approved"))).limit(1);if(!sender||!recipient)return Response.json({error:"Sender or recipient profile not found"},{status:404});if(sender.handle===recipientHandle)return Response.json({error:"You cannot mail yourself"},{status:400});
 const [blocked]=await db.select({id:profileRelations.id}).from(profileRelations).where(and(eq(profileRelations.ownerWallet,recipient.wallet),eq(profileRelations.targetHandle,sender.handle),eq(profileRelations.kind,"block"))).limit(1);if(blocked)return Response.json({error:"This board is not accepting your mail"},{status:403});
 const [message]=await db.insert(boardMessages).values({senderWallet:wallet,senderHandle:sender.handle,recipientWallet:recipient.wallet,recipientHandle,subject,body}).returning();await db.insert(notifications).values({recipientWallet:recipient.wallet,actorWallet:wallet,actorHandle:sender.handle,kind:"mail",body:`New Board Mail from @${sender.handle}: ${subject}`,href:"/board-mail"});return Response.json({message},{status:201});
}
export async function DELETE(request:Request){const p=await request.json() as Proof&{id?:number},id=Number(p.id),data={id},wallet=await authorize(p,"mail:delete",String(id),data);if(!wallet||!Number.isInteger(id))return Response.json({error:"Signed mail action required"},{status:403});const db=getDb(),[message]=await db.select().from(boardMessages).where(eq(boardMessages.id,id)).limit(1);if(!message||(message.senderWallet!==wallet&&message.recipientWallet!==wallet))return Response.json({error:"Message not found"},{status:404});await db.update(boardMessages).set(message.senderWallet===wallet?{deletedBySender:true}:{deletedByRecipient:true}).where(eq(boardMessages.id,id));return Response.json({deleted:true})}
