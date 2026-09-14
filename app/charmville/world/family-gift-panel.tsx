"use client";
import {useEffect,useRef,useState} from 'react';
import {FAMILY_ENTITLEMENT_VERSION,FAMILY_STARTER_SEEDS,type FamilyGiftStatus} from '@/lib/charmville/family-entitlement-contract';

const button='min-h-11 rounded-lg border border-line-strong px-4 py-2 font-bold focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50';
export default function FamilyGiftPanel({token,onSatchel}:{token:string;onSatchel:()=>void|Promise<void>}) {
 const [snapshot,setSnapshot]=useState<{token:string;gift:FamilyGiftStatus}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[later,setLater]=useState(false),[retry,setRetry]=useState(0);
 const action=useRef<AbortController|null>(null);
 const gift=snapshot?.token===token?snapshot.gift:null;
 useEffect(()=>{
  const controller=new AbortController();
  void fetch('/api/charmville/family/accept',{headers:{authorization:`Bearer ${token}`},cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal}).then(async response=>{
   const data=await response.json();if(!response.ok)throw Error(data.error??'Family gift unavailable');
   if(data.available!==false&&(data.available!==true||data.version!==FAMILY_ENTITLEMENT_VERSION||typeof data.accepted!=='boolean'||data.seedQuantity!==FAMILY_STARTER_SEEDS||!/^\d+$/.test(data.seeds)))throw Error('Family gift unavailable');
   if(!controller.signal.aborted){setSnapshot({token,gift:data});setError('');}
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Family gift unavailable');});
  return()=>{controller.abort();action.current?.abort();};
 },[token,retry]);
 async function accept(){
  if(busy||!gift?.available||gift.accepted)return;
  const controller=new AbortController();action.current=controller;setBusy(true);setError('');
  try {
   const response=await fetch('/api/charmville/family/accept',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({accept:FAMILY_ENTITLEMENT_VERSION}),cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal});
   const data=await response.json();if(!response.ok)throw Error(data.error??'Your gift could not be accepted. Try again.');
   if(data.receipt?.version!==FAMILY_ENTITLEMENT_VERSION||data.receipt.seedQuantity!==FAMILY_STARTER_SEEDS)throw Error('Checking your saved gift.');
   if(!controller.signal.aborted)setRetry(value=>value+1);
  }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Your gift could not be accepted. Try again.');}
  finally{if(!controller.signal.aborted)setBusy(false);}
 }
 async function openSatchel(){
  if(busy)return;setBusy(true);setError('');
  try{await onSatchel();}catch(reason){setError(reason instanceof Error?reason.message:'Your Satchel could not be refreshed. Try again.');}
  finally{setBusy(false);}
 }
 if(gift?.available===false||(!gift&&!error))return null;
 if(!gift)return <p role="status" className="mt-3 text-sm text-cream-muted">{error} <button className={button} onClick={()=>setRetry(value=>value+1)}>Retry family gift</button></p>;
 if(!gift.available)return null;
 if(later&&!gift.accepted)return <button className={`${button} mt-3 bg-forest-800 text-cream`} onClick={()=>setLater(false)}>Open family gift</button>;
 return <section aria-label="Your family gift" className="mt-4 rounded-xl border-2 border-line-strong bg-forest-900 p-4 text-cream">
  <div className="flex items-start gap-4">
   <svg aria-hidden="true" viewBox="0 0 64 80" className="h-20 w-16 shrink-0 text-gold-300"><path d="M8 8h48v64H8z" fill="currentColor"/><path d="m8 8 24 12L56 8M8 60h48" fill="none" stroke="var(--color-forest-900)" strokeWidth="3"/><path d="M32 49 19 37c-8-10 5-18 13-8 8-10 21-2 13 8Z" fill="var(--color-forest-700)"/><path d="m31 26 5-12 5 12" fill="var(--color-forest-700)"/><circle cx="25" cy="66" r="2" fill="var(--color-forest-900)"/><circle cx="32" cy="66" r="2" fill="var(--color-forest-900)"/><circle cx="39" cy="66" r="2" fill="var(--color-forest-900)"/></svg>
   <div className="min-w-0"><p className="text-xs font-bold tracking-wide text-gold-300">A GIFT FROM HOME</p><h3 className="mt-1 font-display text-lg text-cream">Burning Heart seeds</h3><p className="mt-2 text-sm text-cream-muted">{gift.accepted?`Your family gift is saved. Burning Heart seeds in your Satchel: ${gift.seeds}.`:'Three seeds to begin with. Grow a little love, then share what you harvest.'}</p></div>
  </div>
  <div className="mt-4 flex flex-wrap gap-2">{gift.accepted?<button disabled={busy} className={`${button} bg-gold-500 text-wood-950`} onClick={()=>void openSatchel()}>{busy?'Opening your Satchel…':'Open Satchel'}</button>:<><button disabled={busy} className={`${button} bg-gold-500 text-wood-950`} onClick={()=>void accept()}>{busy?'Saving your gift…':'Accept family seeds'}</button><button disabled={busy} className={`${button} bg-forest-800 text-cream`} onClick={()=>setLater(true)}>Later</button></>}</div>
  {error&&<p role="status" className="mt-3 text-sm text-cream">{error} Your gift can only be received once; trying again will not duplicate it.</p>}
 </section>;
}
