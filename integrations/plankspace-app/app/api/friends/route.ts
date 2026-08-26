import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { friendRequests, notifications, profileRelations, profiles } from "../../../db/schema";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

const clean=(value:string)=>value.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24);
async function authorize(request:Request,p:Proof,action:string,resource:string,data:unknown){
 return verifyAndConsumeProof(p,`friend:${action}`,resource,await hashJson(data));
}
async function profileForWallet(wallet:string){return (await getDb().select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1))[0]}

export async function POST(request:Request){
 const p=await request.json() as Proof&{action?:string;targetHandle?:string;requestId?:number;decision?:string};
 const action=p.action||"";
 if(action==="list"){
  const data={action:"list"},wallet=await authorize(request,p,"list","self",data);
  if(!wallet)return Response.json({error:"Sign to open your Planks List"},{status:403});
  const db=getDb(),me=await profileForWallet(wallet);if(!me)return Response.json({error:"Create a profile first"},{status:403});
  const relations=await db.select({handle:profileRelations.targetHandle}).from(profileRelations).where(and(eq(profileRelations.ownerWallet,wallet),eq(profileRelations.kind,"friend")));
  const rows=await db.select({handle:profiles.handle,displayName:profiles.displayName,bio:profiles.bio,avatarUrl:profiles.avatarUrl,mood:profiles.mood}).from(profiles).where(eq(profiles.moderationStatus,"approved")),all=rows.filter(x=>x.handle!==me.handle).map(x=>({...x,avatarUrl:x.avatarUrl?`/api/avatar?handle=${x.handle}`:""}));
  const handles=new Set(relations.map(x=>x.handle)),incoming=await db.select().from(friendRequests).where(and(eq(friendRequests.recipientWallet,wallet),eq(friendRequests.status,"pending"))),outgoing=await db.select().from(friendRequests).where(and(eq(friendRequests.requesterWallet,wallet),eq(friendRequests.status,"pending")));
  return Response.json({me:{handle:me.handle},friends:all.filter(x=>handles.has(x.handle)),incoming,outgoing,all});
 }
 if(action==="request"){
  const targetHandle=clean(p.targetHandle||""),data={action:"request",targetHandle},wallet=await authorize(request,p,"request",targetHandle,data);
  if(!wallet||!targetHandle)return Response.json({error:"Sign to send a friend request"},{status:403});
  const db=getDb(),actor=await profileForWallet(wallet),[target]=await db.select().from(profiles).where(eq(profiles.handle,targetHandle)).limit(1);
  if(!actor||target?.moderationStatus!=="approved")return Response.json({error:"Profile not found"},{status:404});
  if(target.wallet===wallet)return Response.json({error:"You are already your own best plank"},{status:400});
  const [friend]=await db.select().from(profileRelations).where(and(eq(profileRelations.ownerWallet,wallet),eq(profileRelations.targetHandle,targetHandle),eq(profileRelations.kind,"friend"))).limit(1);if(friend)return Response.json({error:"You are already friends"},{status:409});
  const [reverse]=await db.select().from(friendRequests).where(and(eq(friendRequests.requesterWallet,target.wallet),eq(friendRequests.recipientWallet,wallet),eq(friendRequests.status,"pending"))).limit(1);if(reverse)return Response.json({error:"This plank already sent you a request. Open your Planks List to accept it."},{status:409});
  await db.insert(friendRequests).values({requesterWallet:wallet,requesterHandle:actor.handle,recipientWallet:target.wallet,recipientHandle:target.handle}).onConflictDoUpdate({target:[friendRequests.requesterWallet,friendRequests.recipientWallet],set:{status:"pending",updatedAt:new Date().toISOString()}});
  await db.insert(notifications).values({recipientWallet:target.wallet,actorWallet:wallet,actorHandle:actor.handle,kind:"friend_request",body:`@${actor.handle} sent you a friend request.`,href:"/planks-list"});
  return Response.json({status:"pending"},{status:201});
 }
 if(action==="respond"){
  const requestId=Number(p.requestId),decision=p.decision==="accept"?"accept":"decline",data={action:"respond",requestId,decision},wallet=await authorize(request,p,"respond",String(requestId),data);
  if(!wallet||!Number.isInteger(requestId))return Response.json({error:"Sign to answer this request"},{status:403});
  const db=getDb(),[item]=await db.select().from(friendRequests).where(and(eq(friendRequests.id,requestId),eq(friendRequests.recipientWallet,wallet),eq(friendRequests.status,"pending"))).limit(1);if(!item)return Response.json({error:"Friend request not found"},{status:404});
  await db.update(friendRequests).set({status:decision==="accept"?"accepted":"declined",updatedAt:new Date().toISOString()}).where(eq(friendRequests.id,requestId));
  if(decision==="accept"){
   await db.insert(profileRelations).values({ownerWallet:item.requesterWallet,targetHandle:item.recipientHandle,kind:"friend",rank:0}).onConflictDoNothing();
   await db.insert(profileRelations).values({ownerWallet:item.recipientWallet,targetHandle:item.requesterHandle,kind:"friend",rank:0}).onConflictDoNothing();
   await db.insert(notifications).values({recipientWallet:item.requesterWallet,actorWallet:item.recipientWallet,actorHandle:item.recipientHandle,kind:"friend_accept",body:`@${item.recipientHandle} accepted your friend request.`,href:`/u/${item.recipientHandle}`});
  }
  return Response.json({status:decision==="accept"?"accepted":"declined"});
 }
 if(action==="remove"){
  const targetHandle=clean(p.targetHandle||""),data={action:"remove",targetHandle},wallet=await authorize(request,p,"remove",targetHandle,data);
  if(!wallet)return Response.json({error:"Sign to remove this friend"},{status:403});
  const db=getDb(),me=await profileForWallet(wallet),[target]=await db.select().from(profiles).where(eq(profiles.handle,targetHandle)).limit(1);if(!me||!target)return Response.json({error:"Profile not found"},{status:404});if(targetHandle==="degenwaffle")return Response.json({error:"DegenWaffle is every plank’s founding friend"},{status:409});
  await db.delete(profileRelations).where(or(and(eq(profileRelations.ownerWallet,wallet),eq(profileRelations.targetHandle,targetHandle),eq(profileRelations.kind,"friend")),and(eq(profileRelations.ownerWallet,target.wallet),eq(profileRelations.targetHandle,me.handle),eq(profileRelations.kind,"friend"))));
  return Response.json({status:"removed"});
 }
 return Response.json({error:"Invalid friend action"},{status:400});
}
