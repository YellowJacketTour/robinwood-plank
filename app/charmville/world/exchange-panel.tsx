"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {charmName} from "@/lib/charmville/item-display";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Offer={id:string;owner:string;side:"buy"|"sell";face:string;price:string;remaining:string};
type Command={kind:"create"|"fill"|"cancel";requestId:string;offerId?:string;side?:string;face?:string;quantity?:string;price?:string};
type Review={command:Command;summary:string};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gold-300";
const input="min-h-11 rounded-lg border border-line bg-wood-950 px-3 py-2 text-cream";
export default function ExchangePanel({wallet,handle,onChanged}:{wallet:string;handle:string;onChanged?:()=>void}) {
 const [offers,setOffers]=useState<Offer[]>([]),[definitions,setDefinitions]=useState<string[]>([]);
 const [side,setSide]=useState("sell"),[face,setFace]=useState("stalk"),[quantity,setQuantity]=useState("1"),[price,setPrice]=useState("1");
 const [fills,setFills]=useState<Record<string,string>>({});
 const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [uncertain,setUncertain]=useState(false);
 const epoch=useRef(0),abort=useRef<AbortController|null>(null),readAbort=useRef<AbortController|null>(null);
 const load=useCallback(async()=>{
  const version=epoch.current;readAbort.current?.abort();const controller=new AbortController();readAbort.current=controller;
  try{const response=await fetch("/api/charmville/exchange",{cache:"no-store",mode:"same-origin",redirect:"error",signal:controller.signal});const data=await response.json();if(version!==epoch.current||controller.signal.aborted)return;if(!response.ok)throw new Error(data.error??"Exchange unavailable");setOffers(data.offers);setDefinitions(data.definitions);}
  catch(error){if(version===epoch.current&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:"Exchange unavailable");}
 },[]);
 useEffect(()=>{let disposed=false;const versions=epoch,controllers=abort,reads=readAbort;void Promise.resolve().then(()=>{if(!disposed)void load();});return()=>{disposed=true;++versions.current;controllers.current?.abort();reads.current?.abort();};},[load,wallet,handle]);
 function whole(value:string,max:bigint){if(!/^[1-9]\d{0,9}$/.test(value)||BigInt(value)>max)throw new Error("Enter a valid whole quantity and Grain price.");return BigInt(value);}
 function prepare(command:Command,summary:string){if(uncertain)return;setMessage("");setReview({command,summary});}
 async function confirm(){
  if(!review||busy)return;
  const version=epoch.current,controller=new AbortController();abort.current=controller;setBusy(true);setMessage("");let dispatched=false,definitive=false;
  try{
   const proof=await savedWalletProof(wallet);if(version!==epoch.current||controller.signal.aborted)return;if(!proof.sessionToken)throw new Error("Sign in again to trade.");
   dispatched=true;const response=await fetch("/api/charmville/exchange",{method:"POST",headers:{authorization:`Bearer ${proof.sessionToken}`,"Content-Type":"application/json"},body:JSON.stringify(review.command),signal:controller.signal,cache:"no-store",mode:"same-origin",redirect:"error"});
   const data=await response.json();if(version!==epoch.current||controller.signal.aborted)return;definitive=true;setUncertain(false);if(!response.ok)throw new Error(data.error??"Trade could not complete.");
   setReview(null);setMessage("Exchange action saved. Your inventory has been updated.");onChanged?.();await load();
  }catch(error){if(version===epoch.current&&!controller.signal.aborted){setUncertain(dispatched&&!definitive);setMessage(dispatched&&!definitive?"The result is uncertain. Retry this same confirmation to recover the saved result without creating another trade.":error instanceof Error?error.message:"Trade could not complete.");}}
  finally{if(version===epoch.current&&!controller.signal.aborted)setBusy(false);}
 }
 return <section aria-label="Grained Exchange" className="mt-6 rounded-xl border border-line bg-panel p-5 text-cream">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-2xl">Grained Exchange</h2><button className={button} type="button" disabled={busy||uncertain} onClick={()=>void load()}>Refresh offers</button></div>
  <p className="mt-2 text-sm text-cream-muted">Player offers at fixed Grain prices. Sell offers reserve charms; buy offers reserve Grain. Another player must accept your offer. Oran Berry harvests and other available Satchel charms use these same balances.</p>
  <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={event=>{event.preventDefault();try{const qty=whole(quantity,1000000n),cost=qty*whole(price,1000000000n);prepare({kind:"create",requestId:crypto.randomUUID(),side,face,quantity,price},side==="sell"?`Reserve ${qty} ${charmName(face)} to sell at ${price} Grain each (${cost} Grain if fully accepted).`:`Reserve ${cost} Grain to buy ${qty} ${charmName(face)} at ${price} Grain each.`);}catch(error){setMessage((error as Error).message);}}}>
   <label className="grid gap-1 text-sm">Offer<select className={input} value={side} onChange={e=>setSide(e.target.value)} disabled={busy||uncertain}><option value="sell">Sell charms</option><option value="buy">Buy charms</option></select></label>
   <label className="grid gap-1 text-sm">Charm<select className={input} value={face} onChange={e=>setFace(e.target.value)} disabled={busy||uncertain}>{definitions.map(d=><option key={d} value={d}>{charmName(d)}</option>)}</select></label>
   <label className="grid gap-1 text-sm">Quantity<input className={`${input} w-28`} inputMode="numeric" value={quantity} onChange={e=>setQuantity(e.target.value)} disabled={busy||uncertain} /></label>
   <label className="grid gap-1 text-sm">Grain each<input className={`${input} w-28`} inputMode="numeric" value={price} onChange={e=>setPrice(e.target.value)} disabled={busy||uncertain} /></label>
   <button className={button} disabled={busy||uncertain||!definitions.length} type="submit">Review offer</button>
  </form>
  <p role="status" className="mt-3 text-sm text-cream-muted">{busy?"Saving exchange action…":message}</p>
  {review && <section aria-label="Review exchange action" className="my-4 rounded-lg border border-line-strong bg-wood-950 p-4"><h3 className="font-bold text-gold-300">Review exchange action</h3><p className="my-3">{review.summary}</p><div className="flex gap-3"><button type="button" className={button} disabled={busy} onClick={()=>void confirm()}>Confirm exchange action</button><button type="button" className={button} disabled={busy||uncertain} onClick={()=>setReview(null)}>Back</button></div></section>}
  {!offers.length?<p className="mt-4 text-cream-muted">No open offers yet.</p>:<ul className="mt-4 divide-y divide-line">{offers.map(offer=><li className="flex flex-wrap items-center justify-between gap-3 py-4" key={offer.id}><div><strong className="text-gold-300">{offer.owner===handle?"Your":`@${offer.owner}’s`} {offer.side} offer</strong><p>{offer.remaining} {charmName(offer.face)} · {offer.price} Grain each</p></div>{offer.owner===handle?<button type="button" className={button} disabled={busy||uncertain} onClick={()=>prepare({kind:"cancel",requestId:crypto.randomUUID(),offerId:offer.id},`Cancel this offer and return its remaining reserved ${offer.side==="sell"?`${offer.remaining} ${charmName(offer.face)}`:`${BigInt(offer.remaining)*BigInt(offer.price)} Grain`}.`)}>Cancel offer</button>:<form className="flex flex-wrap gap-2" onSubmit={event=>{event.preventDefault();try{const qty=whole(fills[offer.id]??"1",BigInt(offer.remaining)),cost=qty*BigInt(offer.price);prepare({kind:"fill",requestId:crypto.randomUUID(),offerId:offer.id,quantity:qty.toString()},offer.side==="sell"?`Pay ${cost} Grain and receive ${qty} ${charmName(offer.face)} from @${offer.owner}.`:`Give ${qty} ${charmName(offer.face)} and receive ${cost} Grain from @${offer.owner}.`);}catch(error){setMessage((error as Error).message);}}}><input aria-label={`Quantity for ${offer.owner} ${charmName(offer.face)} offer`} className={`${input} w-24`} inputMode="numeric" value={fills[offer.id]??"1"} disabled={busy||uncertain} onChange={e=>setFills({...fills,[offer.id]:e.target.value})}/><button className={button} disabled={busy||uncertain} type="submit">{offer.side==="sell"?"Review purchase":"Review sale"}</button></form>}</li>)}</ul>}
 </section>;
}
