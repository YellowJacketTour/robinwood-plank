import { and, eq, lt } from "drizzle-orm";
import { verifyMessage } from "viem";
import { getDb } from "../../../../db";
import { authChallenges, walletSessions } from "../../../../db/schema";
import { authorizationMessage, type Proof } from "../verify";

async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}

export async function GET(request:Request){
  const url=new URL(request.url),wallet=(url.searchParams.get("wallet")||"").toLowerCase(),token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"";
  if(!/^0x[a-f0-9]{40}$/.test(wallet)||!token)return Response.json({active:false});
  const db=getDb();await db.delete(walletSessions).where(lt(walletSessions.expiresAt,new Date().toISOString()));
  const [session]=await db.select().from(walletSessions).where(and(eq(walletSessions.tokenHash,await sha256(token)),eq(walletSessions.wallet,wallet))).limit(1);
  return Response.json({active:Boolean(session&&Date.parse(session.expiresAt)>Date.now()),expiresAt:session?.expiresAt||null});
}

export async function POST(request:Request){
  const proof=await request.json() as Proof,wallet=(proof.wallet||"").toLowerCase() as `0x${string}`;
  if(!/^0x[a-f0-9]{40}$/.test(wallet)||!proof.nonce||!proof.message||!proof.signature)return Response.json({error:"A wallet signature is required"},{status:403});
  const db=getDb(),[challenge]=await db.select().from(authChallenges).where(and(eq(authChallenges.nonce,proof.nonce),eq(authChallenges.wallet,wallet))).limit(1);
  if(!challenge||challenge.action!=="session:create"||challenge.resource!==wallet||Date.parse(challenge.expiresAt)<Date.now())return Response.json({error:"That verification request expired"},{status:403});
  const expected=authorizationMessage(wallet,challenge.action,challenge.resource,challenge.payloadHash,challenge.nonce,challenge.expiresAt);
  if(proof.message!==expected||!await verifyMessage({address:wallet,message:expected,signature:proof.signature}))return Response.json({error:"Wallet signature did not match"},{status:403});
  await db.delete(authChallenges).where(eq(authChallenges.nonce,challenge.nonce));
  const bytes=crypto.getRandomValues(new Uint8Array(32)),token=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""),expiresAt=new Date(Date.now()+12*60*60*1000).toISOString();
  await db.delete(walletSessions).where(eq(walletSessions.wallet,wallet));
  await db.insert(walletSessions).values({tokenHash:await sha256(token),wallet,expiresAt});
  return Response.json({token,wallet,expiresAt});
}
