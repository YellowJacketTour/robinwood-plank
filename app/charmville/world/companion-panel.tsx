"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import RestPanel from "./rest-panel";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Choice={speciesId:number;sourceName:string;sprite:string};
type Partner=Choice&{id:string;nickname:string;following:boolean;revision:string};
type State={choices:Choice[];companion:Partner|null;party:Partner[];homeClaimed:boolean};
type Creature={id:string;speciesId:number;nickname:string;source:string;acquisitionKind:string};
type Roster={revision:string;slots:(Creature|null)[];owned:Creature[]};
type Vitals={creatures:{id:string;level:number;hp:number;maxHp:number;revision:string}[];oranQuantity:string};
type Feed={action:"use-oran";requestId:string;creatureId:string;revision:string};
type Command=Feed|{speciesId:number}|{action:"following";companionId:string;following:boolean;revision:string}|{action:"claim-home";requestId:string}|{action:'roster';revision:string;slots:(string|null)[]};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
const primary="min-h-11 rounded-lg border border-line-strong bg-gold-500 px-4 py-2 font-bold text-wood-950 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
function Sprite({choice}:{choice:Choice}) {return <div role="img" aria-label={choice.sourceName} className="mx-auto h-16 w-16 overflow-hidden" style={{backgroundImage:`url(${choice.sprite})`,backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/>;}
export default function CompanionPanel({wallet,handle,onFollower,onFollowers,onPlay,onHomeReady}:{wallet:string;handle:string;onFollower?:(speciesId:number)=>void;onFollowers?:(speciesIds:number[])=>void;onPlay?:()=>void;onHomeReady?:()=>void}) {
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState<Choice|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [roster,setRoster]=useState<Roster|null>(null),[selectedSlot,setSelectedSlot]=useState(0);
 const [vitals,setVitals]=useState<Vitals|null>(null);
 const pendingFeed=useRef<Feed|null>(null);
 const [pendingFeedId,setPendingFeedId]=useState<string|null>(null);
 const version=useRef(0),abort=useRef<AbortController|null>(null);
 const homeRequestId=useRef<string|null>(null);
 const request=useCallback(async(command?:Command)=>{
  abort.current?.abort();const controller=new AbortController();abort.current=controller;const current=++version.current;setBusy(true);setMessage("");
  try{
   const proof=await savedWalletProof(wallet);if(controller.signal.aborted||current!==version.current)return;
   if(!proof.sessionToken){onFollower?.(0);onFollowers?.([]);setRoster(null);setVitals(null);throw new Error("Sign in to view your party.");}
   const claiming=command&&'action' in command&&command.action==='claim-home';
   const options={headers:{authorization:`Bearer ${proof.sessionToken}`,"Content-Type":"application/json"},cache:"no-store" as const,mode:"same-origin" as const,redirect:"error" as const,signal:controller.signal};
   if(claiming){
    const claim=await fetch(`/api/charmville/${encodeURIComponent(handle)}`,{...options,method:"POST",body:JSON.stringify({action:"claim",requestId:command.requestId})});
    if(!claim.ok){const error=await claim.json();throw new Error(error.error??"Home setup could not be confirmed. Retry to check the same request.");}
    if(controller.signal.aborted||current!==version.current)return;
   }
   const feeding=command&&'action' in command&&command.action==='use-oran';
   if(feeding){const response=await fetch('/api/charmville/companions/vitals',{...options,method:'POST',body:JSON.stringify(command)});const result=await response.json();if(controller.signal.aborted||current!==version.current)return;if(!response.ok){if([400,403,404,409,422].includes(response.status)){pendingFeed.current=null;setPendingFeedId(null);}throw new Error(result.error??'Feeding could not be confirmed. Retry the same feed.');}pendingFeed.current=null;setPendingFeedId(null);setVitals(result);setMessage(`Recovered ${result.result.healed} HP.`);onHomeReady?.();}
   const editingRoster=command&&'action' in command&&command.action==='roster';
   if(editingRoster){const edit=await fetch('/api/charmville/creature-roster',{...options,method:'POST',body:JSON.stringify({revision:command.revision,slots:command.slots})});if(!edit.ok){const error=await edit.json();throw new Error(error.error??'Your party changed. Refresh before trying again.');}}
   const response=await fetch("/api/charmville/companions",{...options,method:command&&!claiming&&!editingRoster&&!feeding?"POST":"GET",body:command&&!claiming&&!editingRoster&&!feeding?JSON.stringify(command):undefined});
   const data=await response.json();if(controller.signal.aborted||current!==version.current)return;
   if(!response.ok){if(response.status===401||response.status===403){setState(null);setRoster(null);setVitals(null);onFollower?.(0);onFollowers?.([]);}throw new Error(data.error??"Companions unavailable. Refresh your party to check its state.");}
   setState(data);setSelection(null);if(claiming)onHomeReady?.();if(data.homeClaimed)homeRequestId.current=null;onFollower?.(data.companion?.following?data.companion.speciesId:0);
   const rosterResponse=await fetch('/api/charmville/creature-roster',options);
   const nextRoster=await rosterResponse.json();if(controller.signal.aborted||current!==version.current)return;
   if(!rosterResponse.ok){setRoster(null);onFollowers?.([]);throw new Error(nextRoster.error??'Your party could not be loaded. Refresh to retry.');}
   setRoster(nextRoster);onFollowers?.(data.companion?.following?nextRoster.slots.filter((entry:Creature|null)=>entry&&[277,280,283].includes(entry.speciesId)).map((entry:Creature)=>entry.speciesId):[]);
   const health=await fetch('/api/charmville/companions/vitals',options);const healthData=await health.json();if(controller.signal.aborted||current!==version.current)return;if(!health.ok){setVitals(null);throw new Error(healthData.error??'Companion health unavailable.');}setVitals(healthData);
  }catch(error){if(!controller.signal.aborted&&current===version.current)setMessage(error instanceof Error?error.message:"Party could not be saved. Refresh to check its state.");}
  finally{if(!controller.signal.aborted&&current===version.current)setBusy(false);}
 },[wallet,handle,onFollower,onFollowers,onHomeReady]);
 useEffect(()=>{let disposed=false;const versions=version,controllers=abort;void Promise.resolve().then(()=>{if(!disposed)void request();});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 useEffect(()=>{const refresh=()=>{void request();};window.addEventListener('charmville:companion-health-changed',refresh);return()=>window.removeEventListener('charmville:companion-health-changed',refresh);},[request]);
 const partner=state?.companion;
 const homeReady=state?.homeClaimed===true;
 const slots=roster?.slots??Array.from({length:6},()=>null);
 const selectedCreature=slots[selectedSlot];
 const selectedVitals=vitals?.creatures.find(creature=>creature.id===selectedCreature?.id);
 const feedReason=!selectedVitals?"Loading health…":selectedVitals.hp===0?"A fainted companion needs revival.":selectedVitals.hp>=selectedVitals.maxHp?"Already at full health.":!vitals||vitals.oranQuantity==="0"?"Gather an Oran Berry first.":"Uses one Oran Berry to restore up to 10 HP.";
 const selectedArt=state?.choices.find(choice=>choice.speciesId===selectedCreature?.speciesId);
 return <section aria-label="Your companion" className="rounded-2xl border-2 border-line-strong bg-wood-900 p-4 text-cream shadow-lg">
  <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-widest text-gold-300">Charmdex</p>
  <div className="flex items-center justify-between gap-2 border-b border-line pb-2"><h2 className="font-display text-xl">Your party</h2><span className="text-sm text-cream-muted">{roster?`${slots.filter(Boolean).length} / 6`:'Loading…'}</span></div>
  <ol aria-label="Party belt" className="my-3 grid grid-cols-6 gap-2">{slots.map((creature,index)=><li key={index} aria-label={`Slot ${index+1}: ${creature?creature.nickname:"Empty"}`}><button type="button" aria-label={`View slot ${index+1}: ${creature?.nickname??'Empty'}`} aria-pressed={selectedSlot===index} onClick={()=>setSelectedSlot(index)} className={`flex min-h-11 w-full items-center justify-center rounded-full border text-sm focus-visible:outline-2 focus-visible:outline-gold-300 ${selectedSlot===index?"border-line-strong bg-gold-500 text-wood-950 ring-2 ring-gold-300 ring-offset-2 ring-offset-wood-900":creature?"border-line-strong bg-panel-soft text-gold-300":"border-line bg-panel-soft text-cream-muted"}`}>{index+1}</button></li>)}</ol>
  <ol aria-label="Getting started" className="mb-3 grid grid-cols-3 gap-1 text-center text-xs"><li className={homeReady?"text-gold-300":"text-cream"}>{homeReady?"✓":"1"} Home</li><li className={partner?"text-gold-300":"text-cream-muted"}>{partner?"✓":"2"} Choose</li><li className={partner?.following?"text-gold-300":"text-cream-muted"}>{partner?.following?"✓":"3"} Walk</li></ol>
  {roster&&(partner||roster.owned.length>0)&&<div className="mb-3 rounded-lg border border-line p-3 text-center">{selectedCreature?<>{selectedArt&&<Sprite choice={selectedArt}/>}<h3 className="font-bold text-gold-300">{selectedCreature.nickname}</h3><p className="text-sm text-cream-muted">{selectedCreature.id===partner?.id?'Your account-bound partner':'Your companion'}</p></>:<p className="text-sm text-cream-muted">This party slot is empty.</p>}
   {selectedVitals&&<div className="my-3 text-left"><div className="flex justify-between text-sm"><span>Level {selectedVitals.level}</span><span>HP {selectedVitals.hp} / {selectedVitals.maxHp}</span></div><meter aria-label="Companion HP" min={0} max={selectedVitals.maxHp} value={selectedVitals.hp} className="mt-1 h-4 w-full"/><button type="button" className={`${button} mt-2 w-full`} disabled={busy||(!pendingFeedId&&(selectedVitals.hp===0||selectedVitals.hp>=selectedVitals.maxHp||vitals?.oranQuantity==='0'))||!!(pendingFeedId&&pendingFeedId!==selectedVitals.id)} onClick={()=>{pendingFeed.current??={action:'use-oran',requestId:crypto.randomUUID(),creatureId:selectedVitals.id,revision:selectedVitals.revision};setPendingFeedId(pendingFeed.current.creatureId);void request(pendingFeed.current);}}>{pendingFeedId?'Retry Oran feed':'Feed Oran Berry'}</button><p className="mt-1 text-xs text-cream-muted">{feedReason} {vitals?.oranQuantity??'0'} in your Satchel.</p></div>}
   {selectedCreature&&<RestPanel key={`rest:${wallet}`} wallet={wallet} creatureId={selectedCreature.id}/>}
   <label className="mt-2 block text-sm">Slot {selectedSlot+1}<select aria-label={`Assign party slot ${selectedSlot+1}`} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-wood-900 px-2 text-cream" disabled={busy} value={selectedCreature?.id??''} onChange={event=>{const next=slots.map(entry=>entry?.id??null);const chosen=event.target.value||null;for(let i=0;i<next.length;i++)if(chosen&&next[i]===chosen)next[i]=null;next[selectedSlot]=chosen;void request({action:'roster',revision:roster.revision,slots:next});}}><option value="">Empty</option>{roster.owned.map(entry=><option key={entry.id} value={entry.id}>{entry.nickname}</option>)}</select></label>
   {partner&&<div className="mt-3 border-t border-line pt-3"><p className="mb-3 text-sm text-cream-muted">{partner.following?"Your party is walking with you.":"Bring your party along."} Applies to all supported occupied slots.</p><div className="flex flex-wrap justify-center gap-2"><button type="button" className={partner.following?button:primary} disabled={busy} aria-pressed={partner.following} onClick={()=>void request({action:"following",companionId:partner.id,following:!partner.following,revision:partner.revision})}>{partner.following?"Return to party":"Walk with me"}</button>{onPlay&&<button type="button" className={button} disabled={busy} onClick={onPlay}>Return to play</button>}</div></div>}
  </div>}

  {state&&!homeReady&&!partner&&<div className="mb-3 rounded-lg border border-line bg-forest-900 p-3"><p className="mb-2 text-sm">Set up your saved home, then choose your first partner.</p><button type="button" className={primary} disabled={busy} onClick={()=>{homeRequestId.current??=crypto.randomUUID();void request({action:"claim-home",requestId:homeRequestId.current});}}>Set up home</button></div>}
  {partner?<p className="mt-3 text-sm text-cream-muted">Following uses the adventure camera. Battles and capture are not connected yet.</p>:<><p className="my-2 text-sm text-cream-muted">Choose one partner to begin.</p><div className="grid grid-cols-3 gap-2">{state?.choices.map(choice=><button key={choice.speciesId} aria-label={choice.sourceName} aria-pressed={selection?.speciesId===choice.speciesId} type="button" disabled={busy||!homeReady} className={`min-h-24 min-w-0 rounded-lg border px-1 py-2 text-[0.6875rem] font-bold text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50 ${selection?.speciesId===choice.speciesId?"border-line-strong bg-wood-800":"border-line bg-panel-soft"}`} onClick={()=>setSelection(choice)}><Sprite choice={choice}/><span className="block">{choice.sourceName}</span></button>)}</div></>}
  {selection&&!partner&&<div role="group" aria-label="Confirm companion" className="mt-3 rounded-lg border border-line p-3"><p className="mb-3 text-sm">Choose {selection.sourceName}? Your starter choice is permanent.</p><div className="flex flex-wrap gap-2"><button className={primary} type="button" disabled={busy} onClick={()=>void request({speciesId:selection.speciesId})}>Confirm companion</button><button className={button} type="button" disabled={busy} onClick={()=>setSelection(null)}>Back</button></div></div>}
  {(busy||message)&&<p role="status" className="mt-3 text-sm text-cream-muted">{busy?"Loading your party…":message}</p>}<div className="mt-1 flex justify-end"><button type="button" className="min-h-11 text-xs text-cream-muted underline underline-offset-4 disabled:opacity-50" disabled={busy} onClick={()=>void request()}>Refresh companion</button></div>
 </section>;
}
