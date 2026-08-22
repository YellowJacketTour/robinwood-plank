import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { profiles } from "../../../db/schema";
import { hasOwnerSession, OWNER_WALLET } from "../../owner-access-auth";
import { getDelegatedAdminWallet, SAWTOSHI_WALLET } from "../../admin-access-auth";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

export async function POST(request:Request){
 const payload=await request.json() as Proof&{wallet?:string;showTop8?:boolean};
 const ownerBypass=await hasOwnerSession(request),delegated=await getDelegatedAdminWallet(request),bypass=ownerBypass||Boolean(delegated),wallet=(delegated||payload.wallet||"").toLowerCase();
 if(!/^0x[a-f0-9]{40}$/.test(wallet))return Response.json({error:"Valid wallet required"},{status:400});
 if(ownerBypass&&wallet!==OWNER_WALLET)return Response.json({error:"Owner shortcut is limited to DegenWaffle"},{status:403});
 if(delegated&&wallet!==SAWTOSHI_WALLET)return Response.json({error:"Sawtoshi PIN access can only edit Sawtoshi's profile"},{status:403});
 const db=getDb(),[profile]=await db.select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 if(!profile)return Response.json({error:"Profile not found"},{status:404});
 const data={showTop8:payload.showTop8!==false},hash=await hashJson(data);
 if(!bypass&&!await verifyAndConsumeProof(payload,"profile:preferences",profile.handle,hash))return Response.json({error:"Signed ownership proof required"},{status:403});
 let theme:Record<string,unknown>={};try{theme=JSON.parse(profile.themeJson||"{}")}catch{}
 theme.showTop8=data.showTop8;
 await db.update(profiles).set({themeJson:JSON.stringify(theme),updatedAt:new Date().toISOString()}).where(eq(profiles.wallet,wallet));
 return Response.json({ok:true,showTop8:data.showTop8});
}
