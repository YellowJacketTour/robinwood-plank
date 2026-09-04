import { and, eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import { getDb } from "../../../db";
import { authChallenges, walletSessions } from "../../../db/schema";

export type Proof = {wallet?:string;sessionToken?:string;nonce?:string;message?:string;signature?:`0x${string}`;action?:string;resource?:string;payloadHash?:string};

async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}

export function authorizationMessage(wallet:string, action:string, resource:string, payloadHash:string, nonce:string, expiresAt:string) {
  return `PlankSpace wallet verification\nSite: https://plank.love/plankspace\nWallet: ${wallet}\nPurpose: Verify wallet ownership and unlock this wallet's PlankSpace features for 12 hours.\nNonce: ${nonce}\nExpires: ${expiresAt}\n\nSafety: This is only a login signature for Plank.love and PlankSpace. It is not a transaction, cannot move funds, cannot approve tokens, and cannot access your seed phrase or private key.`;
}

export async function verifyAndConsumeProof(proof:Proof, expectedAction:string, expectedResource:string, expectedHash:string) {
  const wallet=(proof.wallet||"").toLowerCase() as `0x${string}`;
  if(/^0x[a-f0-9]{40}$/.test(wallet)&&proof.sessionToken){
    const [session]=await getDb().select().from(walletSessions).where(and(eq(walletSessions.tokenHash,await sha256(proof.sessionToken)),eq(walletSessions.wallet,wallet))).limit(1);
    if(session&&Date.parse(session.expiresAt)>Date.now())return wallet;
  }
  if(!/^0x[a-f0-9]{40}$/.test(wallet)||!proof.nonce||!proof.message||!proof.signature)return null;
  const db=getDb();
  const [challenge]=await db.select().from(authChallenges).where(and(eq(authChallenges.nonce,proof.nonce),eq(authChallenges.wallet,wallet))).limit(1);
  if(!challenge||Date.parse(challenge.expiresAt)<Date.now()||challenge.action!==expectedAction||challenge.resource!==expectedResource||challenge.payloadHash!==expectedHash)return null;
  const expected=authorizationMessage(wallet,expectedAction,expectedResource,expectedHash,challenge.nonce,challenge.expiresAt);
  if(proof.message!==expected||!await verifyMessage({address:wallet,message:expected,signature:proof.signature}))return null;
  const consumed=await db.delete(authChallenges).where(and(eq(authChallenges.nonce,challenge.nonce),eq(authChallenges.wallet,wallet))).returning({wallet:authChallenges.wallet});
  return consumed.length===1?wallet:null;
}
