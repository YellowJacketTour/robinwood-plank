import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { xAccounts } from "../../../../db/schema";
import { hashJson } from "../../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../../auth/verify";

export async function POST(request:Request){const payload=await request.json() as Proof&{handle?:string},handle=String(payload.handle||"").toLowerCase(),wallet=await verifyAndConsumeProof(payload,"x:disconnect",handle,await hashJson({handle}));if(!wallet)return Response.json({error:"Signed owner proof required"},{status:403});await getDb().delete(xAccounts).where(eq(xAccounts.wallet,wallet));return Response.json({connected:false})}
