"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Choice={speciesId:number;sourceName:string;sprite:string};
type Partner=Choice&{id:string;nickname:string;following:boolean;revision:string};
type State={choices:Choice[];companion:Partner|null;party:Partner[]};
type Command={speciesId:number}|{action:"following";companionId:string;following:boolean;revision:string};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
function Sprite({choice}:{choice:Choice}) {return <div role="img" aria-label={choice.sourceName} className="mx-auto h-16 w-16 overflow-hidden" style={{backgroundImage:`url(${choice.sprite})`,backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/>;}
export default function CompanionPanel({wallet,onFollower}:{wallet:string;onFollower?:(speciesId:number)=>void}) {
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState<Choice|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const version=useRef(0),abort=useRef<AbortController|null>(null);
 const request=useCallback(async(command?:Command)=>{
  abort.current?.abort();const controller=new AbortController();abort.current=controller;const current=++version.current;setBusy(true);setMessage("");
  try{
   const proof=await savedWalletProof(wallet);if(controller.signal.aborted||current!==version.current)return;
   if(!proof.sessionToken){onFollower?.(0);throw new Error("Sign in to view your party.");}
   const response=await fetch("/api/charmville/companions",{method:command?"POST":"GET",headers:{authorization:`Bearer ${proof.sessionToken}`,"Content-Type":"application/json"},body:command?JSON.stringify(command):undefined,cache:"no-store",mode:"same-origin",redirect:"error",signal:controller.signal});
   const data=await response.json();if(controller.signal.aborted||current!==version.current)return;
   if(!response.ok){if(response.status===401||response.status===403){setState(null);onFollower?.(0);}throw new Error(data.error??"Companions unavailable. Refresh your party to check its state.");}
   setState(data);setSelection(null);onFollower?.(data.companion?.following?data.companion.speciesId:0);
  }catch(error){if(!controller.signal.aborted&&current===version.current)setMessage(error instanceof Error?error.message:"Party could not be saved. Refresh to check its state.");}
  finally{if(!controller.signal.aborted&&current===version.current)setBusy(false);}
 },[wallet,onFollower]);
 useEffect(()=>{let disposed=false;const versions=version,controllers=abort;void Promise.resolve().then(()=>{if(!disposed)void request();});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 const partner=state?.companion;
 return <section aria-label="Your companion" className="rounded-xl border border-line bg-panel p-4 text-cream">
  <div className="flex items-center justify-between gap-2"><h2 className="font-display text-2xl">Your party</h2><span className="text-sm text-cream-muted">{partner?1:0} / 6</span></div>
  <ol aria-label="Party belt" className="my-4 grid grid-cols-6 gap-2">{Array.from({length:6},(_,index)=><li key={index} aria-label={`Slot ${index+1}: ${index===0&&partner?partner.nickname:"Empty"}`} className={`flex min-h-10 items-center justify-center rounded-full border text-sm ${index===0&&partner?"border-line-strong bg-gold-500 text-wood-950":"border-line bg-panel-soft text-cream-muted"}`}>{index+1}</li>)}</ol>
  {partner?<>
   <div className="rounded-xl border border-line-strong bg-panel-soft p-4 text-center"><Sprite choice={partner}/><h3 className="mt-2 text-lg font-bold text-gold-300">{partner.nickname}</h3><p className="mt-1 text-sm text-cream-muted">Your account-bound partner</p><p className="my-3 text-sm">{partner.following?"Walking with you":"Resting in your party"}</p>
    <button type="button" className={button} disabled={busy} aria-pressed={partner.following} onClick={()=>void request({action:"following",companionId:partner.id,following:!partner.following,revision:partner.revision})}>{partner.following?"Return to party":"Walk with me"}</button>
   </div>
   <p className="mt-3 text-sm text-cream-muted">Following appears in the local adventure camera. Battles, capture and additional party members are not connected yet.</p>
  </>:<><p className="my-3 text-sm text-cream-muted">Choose your first partner. Your starter choice is permanent and saved to your account.</p><div className="grid gap-2">{state?.choices.map(choice=><button key={choice.speciesId} aria-label={choice.sourceName} type="button" disabled={busy} className={button} onClick={()=>setSelection(choice)}><Sprite choice={choice}/>{choice.sourceName}</button>)}</div></>}
  {selection&&!partner&&<div role="group" aria-label="Confirm companion" className="mt-3 rounded-lg border border-line p-3"><p className="mb-3">Choose {selection.sourceName} as your one starter companion?</p><div className="flex flex-wrap gap-2"><button className={button} type="button" disabled={busy} onClick={()=>void request({speciesId:selection.speciesId})}>Confirm companion</button><button className={button} type="button" disabled={busy} onClick={()=>setSelection(null)}>Back</button></div></div>}
  <p role="status" className="mt-3 text-sm text-cream-muted">{busy?"Loading your party…":message}</p><button type="button" className={`${button} mt-2`} disabled={busy} onClick={()=>void request()}>Refresh companion</button>
 </section>;
}
