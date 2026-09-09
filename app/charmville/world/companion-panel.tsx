"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Choice={speciesId:number;sourceName:string;sprite:string};
type State={choices:Choice[];companion:(Choice&{id:string;nickname:string})|null};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 disabled:opacity-50";
function Sprite({choice}:{choice:Choice}) {return <div role="img" aria-label={choice.sourceName} className="mx-auto h-16 w-16 overflow-hidden" style={{backgroundImage:`url(${choice.sprite})`,backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/>;}
export default function CompanionPanel({wallet}:{wallet:string}) {
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState<Choice|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const version=useRef(0),abort=useRef<AbortController|null>(null);
 const request=useCallback(async(speciesId?:number)=>{
  abort.current?.abort();const controller=new AbortController();abort.current=controller;const current=++version.current;setBusy(true);setMessage("");
  try{const proof=await savedWalletProof(wallet);if(controller.signal.aborted||current!==version.current)return;if(!proof.sessionToken)throw new Error("Sign in to choose your companion.");
   const response=await fetch("/api/charmville/companions",{method:speciesId===undefined?"GET":"POST",headers:{authorization:`Bearer ${proof.sessionToken}`,"Content-Type":"application/json"},body:speciesId===undefined?undefined:JSON.stringify({speciesId}),cache:"no-store",mode:"same-origin",redirect:"error",signal:controller.signal});const data=await response.json();if(controller.signal.aborted||current!==version.current)return;if(!response.ok)throw new Error(data.error??"Companions unavailable");setState(data);setSelection(null);
  }catch(error){if(!controller.signal.aborted&&current===version.current)setMessage(error instanceof Error?error.message:"Companion could not be saved. Refresh to check your choice.");}
  finally{if(!controller.signal.aborted&&current===version.current)setBusy(false);}
 },[wallet]);
 useEffect(()=>{let disposed=false;const versions=version,controllers=abort;void Promise.resolve().then(()=>{if(!disposed)void request();});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 return <section aria-label="Your companion" className="mt-6 rounded-xl border border-line bg-panel p-5 text-cream"><h2 className="font-display text-2xl">Your companion</h2><p className="my-3 text-sm text-cream-muted">Choose one starter to save to your account. This choice is permanent. Following, battles and evolution are not connected yet.</p>
 {state?.companion?<div className="rounded-lg border border-line p-3 text-center"><Sprite choice={state.companion}/><strong className="text-gold-300">{state.companion.nickname}</strong><p className="mt-2 text-sm text-cream-muted">Your account-bound partner</p></div>:<div className="grid gap-2">{state?.choices.map(choice=><button key={choice.speciesId} type="button" disabled={busy} className={button} onClick={()=>setSelection(choice)}><Sprite choice={choice}/>{choice.sourceName}</button>)}</div>}
 {selection&&!state?.companion&&<div role="group" aria-label="Confirm companion" className="mt-3 rounded-lg border border-line p-3"><p className="mb-3">Choose {selection.sourceName} as your one starter companion?</p><button className={button} type="button" disabled={busy} onClick={()=>void request(selection.speciesId)}>Confirm companion</button><button className={button} type="button" disabled={busy} onClick={()=>setSelection(null)}>Back</button></div>}
 <p role="status" className="mt-3 text-sm text-cream-muted">{busy?"Loading your companion…":message}</p><button type="button" className={button} disabled={busy} onClick={()=>void request()}>Refresh companion</button></section>;
}
