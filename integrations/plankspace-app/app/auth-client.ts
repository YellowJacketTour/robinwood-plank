import { signPlankLoveMessage } from "./plank-love-wallet";

const key=(wallet:string)=>`plankspace-session:${wallet.toLowerCase()}`;

export async function payloadHash(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

async function activeToken(wallet:string){
  const token=localStorage.getItem(key(wallet))||"";
  if(!token)return "";
  const result=await fetch(`/api/auth/session?wallet=${encodeURIComponent(wallet)}`,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.json()).catch(()=>({active:false}));
  if(result.active)return token;
  localStorage.removeItem(key(wallet));
  return "";
}

async function createSession(wallet:string){
  const payload={scope:"plankspace",durationHours:12},hash=await payloadHash(payload),challenge=await fetch("/api/auth/challenge",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,action:"session:create",resource:wallet,payloadHash:hash}),
  }).then(r=>r.json());
  if(!challenge.message||!challenge.nonce)throw new Error(challenge.error||"Could not create a wallet verification request.");
  const signature=await signPlankLoveMessage(challenge.message,wallet),session=await fetch("/api/auth/session",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({wallet,nonce:challenge.nonce,message:challenge.message,signature}),
  }).then(r=>r.json());
  if(!session.token)throw new Error(session.error||"Wallet verification failed.");
  localStorage.setItem(key(wallet),session.token);
  return session.token as string;
}

export async function walletProof(wallet: string, _action: string, _resource: string, _payload: unknown) {
  void _action; void _resource; void _payload;
  const normalized=wallet.toLowerCase(),sessionToken=await activeToken(normalized)||await createSession(normalized);
  return {wallet:normalized,sessionToken};
}
