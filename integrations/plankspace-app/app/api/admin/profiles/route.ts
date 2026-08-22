import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { moderationLogs, profiles, siteSettings } from "../../../../db/schema";
import { hashJson } from "../../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../../auth/verify";

const DEGEN_WAFFLE="0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";
const SAWTOSHI="0x7304b78e28370f45fdf77ca67bdbbf550c3aac34";
const ADMINS=new Set([DEGEN_WAFFLE,SAWTOSHI]);
const statuses=new Set(["approved","pending","removed"]);
const SETTING="auto_approve_profiles";

async function autoApproveProfiles(){
 const [row]=await getDb().select().from(siteSettings).where(eq(siteSettings.key,SETTING)).limit(1);
 return row?.value==="true";
}

export async function POST(request:Request){
 const p=await request.json() as Proof&{action?:string;profileWallet?:string;status?:string;note?:string;enabled?:boolean},claimed=(p.wallet||"").toLowerCase();
 if(!ADMINS.has(claimed))return Response.json({error:"Admin wallet required"},{status:403});
 const action=p.action||"",target=(p.profileWallet||"").toLowerCase(),status=p.status||"",note=(p.note||"").trim().slice(0,300);
 if(!["list","moderate","settings","approve-all"].includes(action))return Response.json({error:"Invalid admin action"},{status:400});
 if(action==="moderate"&&(!/^0x[a-f0-9]{40}$/.test(target)||!statuses.has(status)))return Response.json({error:"Valid profile and status required"},{status:400});
 const data=action==="list"?{action}:
  action==="moderate"?{action:"moderate",profileWallet:target,status,note}:
  action==="settings"?{action:"settings",enabled:Boolean(p.enabled)}:{action:"approve-all"};
 const hash=await hashJson(data),resource=action==="moderate"?target:"admin";
 const wallet=await verifyAndConsumeProof(p,`admin:${action}`,resource,hash);
 if(!wallet||!ADMINS.has(wallet))return Response.json({error:"Verified admin wallet required"},{status:403});
 const db=getDb(),now=new Date().toISOString();
 if(action==="moderate"){
  await db.update(profiles).set({moderationStatus:status,moderationNote:note,updatedAt:now}).where(eq(profiles.wallet,target));
  await db.insert(moderationLogs).values({profileWallet:target,status,note,moderatorWallet:wallet});
 }
 if(action==="settings"){
  await db.insert(siteSettings).values({key:SETTING,value:p.enabled?"true":"false",updatedBy:wallet,updatedAt:now})
   .onConflictDoUpdate({target:siteSettings.key,set:{value:p.enabled?"true":"false",updatedBy:wallet,updatedAt:now}});
 }
 if(action==="approve-all"){
  await db.update(profiles).set({moderationStatus:"approved",moderationNote:"",updatedAt:now}).where(eq(profiles.moderationStatus,"pending"));
 }
 return Response.json({profiles:await db.select().from(profiles).orderBy(desc(profiles.updatedAt)).limit(250),settings:{autoApproveProfiles:await autoApproveProfiles()}});
}
