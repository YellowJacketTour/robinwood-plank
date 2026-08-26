import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { profiles } from "../../../db/schema";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

export async function POST(request:Request){
 const payload=await request.json() as Proof&{wallet?:string;showTop8?:boolean};
 const wallet=(payload.wallet||"").toLowerCase();
 if(!/^0x[a-f0-9]{40}$/.test(wallet))return Response.json({error:"Valid wallet required"},{status:400});
 const db=getDb(),[profile]=await db.select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 if(!profile)return Response.json({error:"Profile not found"},{status:404});
 const data={showTop8:payload.showTop8!==false},hash=await hashJson(data);
 if(!await verifyAndConsumeProof(payload,"profile:preferences",profile.handle,hash))return Response.json({error:"Signed ownership proof required"},{status:403});
 let theme:Record<string,unknown>={};try{theme=JSON.parse(profile.themeJson||"{}")}catch{}
 theme.showTop8=data.showTop8;
 await db.update(profiles).set({themeJson:JSON.stringify(theme),updatedAt:new Date().toISOString()}).where(eq(profiles.wallet,wallet));
 return Response.json({ok:true,showTop8:data.showTop8});
}
