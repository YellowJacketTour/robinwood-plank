"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { savedWalletProof } from "@/integrations/plankspace-app/app/auth-client";

type Grant = {visitor:string;rights:string[];expiresAt:string;revokedAt:string|null;revision:string;active:boolean};
type Access = {owner:boolean;grants:Grant[]};
export default function HomePermissions({handle,wallet}:{handle:string;wallet:string}) {
 const [access,setAccess]=useState<Access|null>(null);
 const [visitor,setVisitor]=useState("");
 const [help,setHelp]=useState(true);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const generation=useRef(0);
 const controller=useRef<AbortController|null>(null);
 const request=useCallback(async(body?:Record<string,unknown>)=>{
  controller.current?.abort();
  const abort=new AbortController();controller.current=abort;
  const version=++generation.current;
  setBusy(true);setMessage("");
  try {
   const proof=await savedWalletProof(wallet);
   if(abort.signal.aborted || version!==generation.current)return;
   if(!proof.sessionToken)throw new Error("Sign in again to manage your garden visitors.");
   const response=await fetch(`/api/charmville/${encodeURIComponent(handle)}/access`,{method:body?"POST":"GET",headers:{authorization:`Bearer ${proof.sessionToken}`,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,cache:"no-store",credentials:"same-origin",redirect:"error",signal:abort.signal});
   const data=await response.json();
   if(abort.signal.aborted || version!==generation.current)return;
   if(!response.ok)throw new Error(response.status===404?"Claim your garden above, then refresh visitors.":data.error??"Could not load garden permissions.");
   setAccess(data);
   if(body)setMessage(body.revoke?"Access revoked.":"Garden access saved for seven days.");
  }catch(error){if(!abort.signal.aborted && version===generation.current)setMessage(error instanceof Error?error.message:"Could not update garden access.");}
  finally{if(!abort.signal.aborted && version===generation.current)setBusy(false);}
 },[handle,wallet]);
 useEffect(()=>{let disposed=false;const versions=generation;const controllers=controller;void Promise.resolve().then(()=>{if(!disposed){setAccess(null);void request();}});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
 return <section aria-label="Garden visitors" className="mt-6 rounded-xl border border-line bg-panel p-5 text-cream">
  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-display text-xl">Garden visitors</h3><button className={button} type="button" disabled={busy} onClick={()=>void request()}>Refresh visitors</button></div>
  <p className="mt-2 text-sm text-cream-muted">Let an approved PlankSpace player tend your saved crops for seven days. Your garden remains publicly viewable; these permissions control helping. Private adventure visits are not connected yet.</p>
  {access?.owner && <form className="mt-4 flex flex-wrap items-end gap-4" onSubmit={event=>{event.preventDefault();const name=visitor.trim().replace(/^@/,"").toLowerCase();if(!/^[a-z0-9_]{1,40}$/.test(name)){setMessage("Enter a valid PlankSpace handle.");return;}void request({visitor:name,revoke:false,revision:access.grants.find(g=>g.visitor===name)?.revision??"0",rights:help?["visit","help"]:["visit"],containers:[],expiresAt:new Date(Date.now()+7*86400000).toISOString()});}}>
   <label className="grid flex-1 gap-2 text-sm">Player handle<input required maxLength={41} value={visitor} onChange={event=>setVisitor(event.target.value)} placeholder="@friend" autoCapitalize="none" autoCorrect="off" disabled={busy} className="min-h-11 min-w-0 rounded-lg border border-line bg-wood-950 px-3 text-cream focus-visible:outline-2 focus-visible:outline-gold-300" /></label>
   <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={help} onChange={event=>setHelp(event.target.checked)} disabled={busy} />Allow crop tending</label>
   <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-gold-500 px-5 py-2 font-bold text-on-gold disabled:opacity-50">Save invitation</button>
  </form>}
  <p role="status" aria-live="polite" className="mt-3 text-sm text-cream-muted">{busy?"Updating visitors…":message}</p>
  {access?.owner && (access.grants.length?<ul className="mt-3 divide-y divide-line">{access.grants.map(grant=><li key={grant.visitor} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><a href={`/u/${encodeURIComponent(grant.visitor)}`} className="font-bold text-gold-300">@{grant.visitor}</a><p className="mt-1 text-sm text-cream-muted">{grant.active?`${grant.rights.includes("help")?"Visit and tend":"Visit"} · Until ${new Date(grant.expiresAt).toLocaleDateString()}`:grant.revokedAt?"Revoked":"Expired"}</p></div>{grant.active && <button type="button" disabled={busy} className={button} aria-label={`Revoke access for ${grant.visitor}`} onClick={()=>void request({visitor:grant.visitor,revoke:true,revision:grant.revision})}>Revoke</button>}</li>)}</ul>:<p className="mt-3 text-sm text-cream-muted">No invitations yet.</p>)}
 </section>;
}
