import { getDb } from "../../../../db";
import { authChallenges } from "../../../../db/schema";
import { authorizationMessage } from "../verify";
import { count, eq, lt } from "drizzle-orm";

const allowedActions=new Set(["session:create"]);
const short=(v:unknown,n:number)=>typeof v==="string"?v.trim().slice(0,n):"";

export async function POST(request:Request){
 try {
 let raw:Record<string,unknown>;try{raw=await request.json()}catch{return Response.json({error:"Invalid request"},{status:400})}
 const wallet=short(raw.wallet,42).toLowerCase(),action=short(raw.action,40),resource=short(raw.resource,80),payloadHash=short(raw.payloadHash,64).toLowerCase();
 if(!/^0x[a-f0-9]{40}$/.test(wallet)||!allowedActions.has(action)||!resource||!/^[a-f0-9]{64}$/.test(payloadHash))return Response.json({error:"Valid wallet authorization details are required"},{status:400});
 const db=getDb(),now=new Date().toISOString();await db.delete(authChallenges).where(lt(authChallenges.expiresAt,now));const [usage]=await db.select({value:count()}).from(authChallenges).where(eq(authChallenges.wallet,wallet));if((usage?.value||0)>=5)return Response.json({error:"Too many active signing requests. Wait a few minutes."},{status:429});
 const nonce=crypto.randomUUID(),expiresAt=new Date(Date.now()+5*60*1000).toISOString();
 const message=authorizationMessage(wallet,action,resource,payloadHash,nonce,expiresAt);
 await db.insert(authChallenges).values({wallet,action,resource,payloadHash,nonce,expiresAt});
 return Response.json({message,nonce,expiresAt});
 } catch (error) {
  console.error("[plankspace-auth] challenge creation failed", error);
  return Response.json({
   error:"PlankSpace storage is unavailable. Configure POSTGRES_URL or DATABASE_URL in Vercel and run npm run db:migrate.",
   code:"PLANKSPACE_STORAGE_UNAVAILABLE"
  },{status:503});
 }
}
