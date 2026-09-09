"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Choice={speciesId:number;sourceName:string;sprite:string};
type Partner=Choice&{id:string;nickname:string;following:boolean;revision:string};
type State={choices:Choice[];companion:Partner|null;party:Partner[];homeClaimed:boolean};
type Command={speciesId:number}|{action:"following";companionId:string;following:boolean;revision:string}|{action:"claim-home";requestId:string};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
const primary="min-h-11 rounded-lg border border-line-strong bg-gold-500 px-4 py-2 font-bold text-wood-950 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
function Sprite({choice}:{choice:Choice}) {return <div role="img" aria-label={choice.sourceName} className="mx-auto h-16 w-16 overflow-hidden" style={{backgroundImage:`url(${choice.sprite})`,backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/>;}
export default function CompanionPanel({wallet,handle,onFollower,onPlay,onHomeReady}:{wallet:string;handle:string;onFollower?:(speciesId:number)=>void;onPlay?:()=>void;onHomeReady?:()=>void}) {
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState<Choice|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const version=useRef(0),abort=useRef<AbortController|null>(null);
 const homeRequestId=useRef<string|null>(null);
 const request=useCallback(async(command?:Command)=>{
  abort.current?.abort();const controller=new AbortController();abort.current=controller;const current=++version.current;setBusy(true);setMessage("");
  try{
   const proof=await savedWalletProof(wallet);if(controller.signal.aborted||current!==version.current)return;
   if(!proof.sessionToken){onFollower?.(0);throw new Error("Sign in to view your party.");}
   const claiming=command&&'action' in command&&command.action==='claim-home';
   const options={headers:{authorization:`Bearer ${proof.sessionToken}`,"Content-Type":"application/json"},cache:"no-store" as const,mode:"same-origin" as const,redirect:"error" as const,signal:controller.signal};
   if(claiming){
    const claim=await fetch(`/api/charmville/${encodeURIComponent(handle)}`,{...options,method:"POST",body:JSON.stringify({action:"claim",requestId:command.requestId})});
    if(!claim.ok){const error=await claim.json();throw new Error(error.error??"Home setup could not be confirmed. Retry to check the same request.");}
    if(controller.signal.aborted||current!==version.current)return;
   }
   const response=await fetch("/api/charmville/companions",{...options,method:command&&!claiming?"POST":"GET",body:command&&!claiming?JSON.stringify(command):undefined});
   const data=await response.json();if(controller.signal.aborted||current!==version.current)return;
   if(!response.ok){if(response.status===401||response.status===403){setState(null);onFollower?.(0);}throw new Error(data.error??"Companions unavailable. Refresh your party to check its state.");}
   setState(data);setSelection(null);if(claiming)onHomeReady?.();if(data.homeClaimed)homeRequestId.current=null;onFollower?.(data.companion?.following?data.companion.speciesId:0);
  }catch(error){if(!controller.signal.aborted&&current===version.current)setMessage(error instanceof Error?error.message:"Party could not be saved. Refresh to check its state.");}
  finally{if(!controller.signal.aborted&&current===version.current)setBusy(false);}
 },[wallet,handle,onFollower,onHomeReady]);
 useEffect(()=>{let disposed=false;const versions=version,controllers=abort;void Promise.resolve().then(()=>{if(!disposed)void request();});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 const partner=state?.companion;
 const homeReady=state?.homeClaimed===true;
 return <section aria-label="Your companion" className="rounded-2xl border-2 border-line-strong bg-wood-900 p-4 text-cream shadow-lg">
  <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-widest text-gold-300">Charmdex</p>
  <div className="flex items-center justify-between gap-2 border-b border-line pb-2"><h2 className="font-display text-xl">Your party</h2><span className="text-sm text-cream-muted">{partner?1:0} / 6</span></div>
  <ol aria-label="Party belt" className="my-3 grid grid-cols-6 gap-2">{Array.from({length:6},(_,index)=><li key={index} aria-label={`Slot ${index+1}: ${index===0&&partner?partner.nickname:"Empty"}`} className={`flex min-h-10 items-center justify-center rounded-full border text-sm ${index===0&&partner?"border-line-strong bg-gold-500 text-wood-950":"border-line bg-panel-soft text-cream-muted"}`}>{index+1}</li>)}</ol>
  <ol aria-label="Getting started" className="mb-3 grid grid-cols-3 gap-1 text-center text-xs"><li className={homeReady?"text-gold-300":"text-cream"}>{homeReady?"✓":"1"} Home</li><li className={partner?"text-gold-300":"text-cream-muted"}>{partner?"✓":"2"} Choose</li><li className={partner?.following?"text-gold-300":"text-cream-muted"}>{partner?.following?"✓":"3"} Walk</li></ol>
  {state&&!homeReady&&!partner&&<div className="mb-3 rounded-lg border border-line bg-forest-900 p-3"><p className="mb-2 text-sm">Set up your saved home, then choose your first partner.</p><button type="button" className={primary} disabled={busy} onClick={()=>{homeRequestId.current??=crypto.randomUUID();void request({action:"claim-home",requestId:homeRequestId.current});}}>Set up home</button></div>}
  {partner?<>
   <div className="rounded-xl border border-line-strong bg-panel-soft p-4 text-center"><Sprite choice={partner}/><h3 className="mt-2 text-lg font-bold text-gold-300">{partner.nickname}</h3><p className="mt-1 text-sm text-cream-muted">Your account-bound partner</p><p className="my-3 text-sm">{partner.following?"Walking with you":"Resting in your party"}</p>
    <div className="flex flex-wrap justify-center gap-2"><button type="button" className={partner.following?button:primary} disabled={busy} aria-pressed={partner.following} onClick={()=>void request({action:"following",companionId:partner.id,following:!partner.following,revision:partner.revision})}>{partner.following?"Return to party":"Walk with me"}</button>{onPlay&&<button type="button" className={button} disabled={busy} onClick={onPlay}>Return to play</button>}</div>
   </div>
   <p className="mt-3 text-sm text-cream-muted">Following appears in the local adventure camera. Battles, capture and additional party members are not connected yet.</p>
  </>:<><p className="my-2 text-sm text-cream-muted">Choose one partner to begin.</p><div className="grid grid-cols-3 gap-2">{state?.choices.map(choice=><button key={choice.speciesId} aria-label={choice.sourceName} aria-pressed={selection?.speciesId===choice.speciesId} type="button" disabled={busy||!homeReady} className={`min-h-24 min-w-0 rounded-lg border px-1 py-2 text-[0.6875rem] font-bold text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50 ${selection?.speciesId===choice.speciesId?"border-line-strong bg-wood-800":"border-line bg-panel-soft"}`} onClick={()=>setSelection(choice)}><Sprite choice={choice}/><span className="block">{choice.sourceName}</span></button>)}</div></>}
  {selection&&!partner&&<div role="group" aria-label="Confirm companion" className="mt-3 rounded-lg border border-line p-3"><p className="mb-3 text-sm">Choose {selection.sourceName}? Your starter choice is permanent.</p><div className="flex flex-wrap gap-2"><button className={primary} type="button" disabled={busy} onClick={()=>void request({speciesId:selection.speciesId})}>Confirm companion</button><button className={button} type="button" disabled={busy} onClick={()=>setSelection(null)}>Back</button></div></div>}
  {(busy||message)&&<p role="status" className="mt-3 text-sm text-cream-muted">{busy?"Loading your party…":message}</p>}<div className="mt-1 flex justify-end"><button type="button" className="min-h-11 text-xs text-cream-muted underline underline-offset-4 disabled:opacity-50" disabled={busy} onClick={()=>void request()}>Refresh companion</button></div>
 </section>;
}
