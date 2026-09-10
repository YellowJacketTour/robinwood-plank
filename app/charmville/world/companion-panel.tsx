"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import TestPartyPanel,{type TestProfile} from "./test-party-panel";
import RestPanel from "./rest-panel";
import {speciesSize} from "@/lib/charmville/creature-sizes";
import {speciesStats} from "@/lib/charmville/creature-stats";
import {savedWalletProof} from "@/integrations/plankspace-app/app/auth-client";
type Choice={speciesId:number;sourceName:string;sprite:string};
type Partner=Choice&{id:string;nickname:string;following:boolean;revision:string};
type State={choices:Choice[];companion:Partner|null;party:Partner[];homeClaimed:boolean};
type Creature={id:string;speciesId:number;nickname:string;source:string;acquisitionKind:string;following:boolean};
type Roster={revision:string;slots:(Creature|null)[];owned:Creature[]};
type Vitals={creatures:{id:string;level:number;hp:number;maxHp:number;revision:string}[];oranQuantity:string};
type Feed={action:"use-oran";requestId:string;creatureId:string;revision:string};
type Command=Feed|{speciesId:number}|{action:"following";companionId:string;following:boolean;revision:string}|{action:"claim-home";requestId:string}|{action:'roster';revision:string;slots:(string|null)[]}|{action:'roster-following';creatureId:string;following:boolean;revision:string};
const button="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
const primary="min-h-11 rounded-lg border border-line-strong bg-gold-500 px-4 py-2 font-bold text-wood-950 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
function Sprite({choice}:{choice:Choice}) {return <div role="img" aria-label={choice.sourceName} className="mx-auto h-16 w-16 shrink-0 overflow-hidden" style={{backgroundImage:`url(${choice.sprite})`,backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/>;}
export default function CompanionPanel({wallet,handle,onFollower,onFollowers,onFormation,onTestProfile,onHomeReady}:{wallet:string;handle:string;onFollower?:(speciesId:number)=>void;onFollowers?:(speciesIds:number[],creatureIds?:string[])=>void;onFormation?:(formation:'close'|'relaxed')=>void;onTestProfile?:(profile:TestProfile)=>void|Promise<void>;onPlay?:()=>void;onHomeReady?:()=>void}) {
 const [state,setState]=useState<State|null>(null),[selection,setSelection]=useState<Choice|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [roster,setRoster]=useState<Roster|null>(null),[selectedSlot,setSelectedSlot]=useState(0);
 const [detail,setDetail]=useState<'summary'|'care'|'organize'>('summary');
 const [formation,setFormation]=useState<'close'|'relaxed'>('close');
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
   const editingRoster=command&&'action' in command&&(command.action==='roster'||command.action==='roster-following');
   if(editingRoster){const edit=await fetch('/api/charmville/creature-roster',{...options,method:'POST',body:JSON.stringify(command.action==='roster'?{revision:command.revision,slots:command.slots}:{action:'following',creatureId:command.creatureId,following:command.following,revision:command.revision})});if(!edit.ok){const error=await edit.json();throw new Error(error.error??'Your party changed. Refresh before trying again.');}}
   const response=await fetch("/api/charmville/companions",{...options,method:command&&!claiming&&!editingRoster&&!feeding?"POST":"GET",body:command&&!claiming&&!editingRoster&&!feeding?JSON.stringify(command):undefined});
   const data=await response.json();if(controller.signal.aborted||current!==version.current)return;
   if(!response.ok){if(response.status===401||response.status===403){setState(null);setRoster(null);setVitals(null);onFollower?.(0);onFollowers?.([]);}throw new Error(data.error??"Companions unavailable. Refresh your party to check its state.");}
   setState(data);setSelection(null);if(claiming)onHomeReady?.();if(data.homeClaimed)homeRequestId.current=null;
   const rosterResponse=await fetch('/api/charmville/creature-roster',options);
   const nextRoster=await rosterResponse.json();if(controller.signal.aborted||current!==version.current)return;
   if(!rosterResponse.ok){setRoster(null);onFollowers?.([]);throw new Error(nextRoster.error??'Your party could not be loaded. Refresh to retry.');}
   setRoster(nextRoster);const followers:Creature[]=nextRoster.slots.filter((entry:Creature|null)=>entry?.following&&[277,280,283,25,133,286].includes(entry.speciesId));onFollowers?.(followers.map(entry=>entry.speciesId),followers.map(entry=>entry.id));
   const health=await fetch('/api/charmville/companions/vitals',options);const healthData=await health.json();if(controller.signal.aborted||current!==version.current)return;if(!health.ok){setVitals(null);throw new Error(healthData.error??'Companion health unavailable.');}setVitals(healthData);
  }catch(error){if(!controller.signal.aborted&&current===version.current)setMessage(error instanceof Error?error.message:"Party could not be saved. Refresh to check its state.");}
  finally{if(!controller.signal.aborted&&current===version.current)setBusy(false);}
 },[wallet,handle,onFollower,onFollowers,onHomeReady]);
 useEffect(()=>{let disposed=false;const versions=version,controllers=abort;void Promise.resolve().then(()=>{if(!disposed)void request();});return()=>{disposed=true;++versions.current;controllers.current?.abort();};},[request]);
 useEffect(()=>{const refresh=()=>{void request();};window.addEventListener('charmville:companion-health-changed',refresh);return()=>window.removeEventListener('charmville:companion-health-changed',refresh);},[request]);
 const refresh=useCallback(()=>{void request();},[request]);
 const partner=state?.companion;
 const homeReady=state?.homeClaimed===true;
 const slots=roster?.slots??Array.from({length:6},()=>null);
 const selectedCreature=slots[selectedSlot];
 const selectedVitals=vitals?.creatures.find(creature=>creature.id===selectedCreature?.id);
 const feedReason=!selectedVitals?"Loading health…":selectedVitals.hp===0?"A fainted companion needs revival.":selectedVitals.hp>=selectedVitals.maxHp?"Already at full health.":!vitals||vitals.oranQuantity==="0"?"Gather an Oran Berry first.":"Uses one Oran Berry to restore up to 10 HP.";
 const portraitNames:Record<number,string>={277:'treecko',280:'torchic',283:'mudkip',25:'pikachu',133:'eevee',286:'poochyena'};
 const portrait=selectedCreature?portraitNames[selectedCreature.speciesId]:null;
 const selectedArt=selectedCreature&&portrait?{speciesId:selectedCreature.speciesId,sourceName:portrait.toUpperCase(),sprite:`/charmville/creatures/${portrait}-front.png`}:null;
 const walking=slots.filter((entry:Creature|null)=>entry?.following).length;
 const size=selectedCreature?speciesSize(selectedCreature.speciesId):null;
 const source=selectedCreature?speciesStats(selectedCreature.speciesId):null;
 return <section aria-label="Your companion" className="@container overflow-hidden rounded-2xl border-2 border-line-strong bg-wood-900 text-cream shadow-xl">
  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-forest-900 px-4 py-3">
   <div><p className="text-xs font-bold uppercase tracking-widest text-gold-300">Charmdex / Party</p><h2 className="mt-1 text-xl font-bold">Your companions</h2></div>
   <div className="text-right text-sm"><p className="font-bold">{roster?`${slots.filter(Boolean).length} / 6`:'Loading…'}</p><p className="text-cream-muted">{walking} walking with you</p></div>
  </header>
  <div className="grid @min-[600px]:grid-cols-[minmax(280px,1fr)_minmax(300px,1.3fr)]">
   <div className="border-b border-line bg-forest-900/40 p-3 @min-[600px]:border-r @min-[600px]:border-b-0">
    <ol aria-label="Party belt" className="grid grid-cols-3 gap-2 @min-[600px]:grid-cols-2">{slots.map((creature:Creature|null,index:number)=>{
     const health=vitals?.creatures.find(entry=>entry.id===creature?.id),name=creature?portraitNames[creature.speciesId]:null;
     return <li key={index} aria-label={`Slot ${index+1}: ${creature?creature.nickname:'Empty'}`}><button type="button" aria-label={`View slot ${index+1}: ${creature?.nickname??'Empty'}`} aria-pressed={selectedSlot===index} onClick={()=>setSelectedSlot(index)} onKeyDown={event=>{const grid=event.currentTarget.closest('ol');const columns=grid?getComputedStyle(grid).gridTemplateColumns.split(' ').length:3;const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:event.key==='ArrowDown'?columns:event.key==='ArrowUp'?-columns:0;if(delta){event.preventDefault();const next=(index+delta+6)%6;setSelectedSlot(next);const list=event.currentTarget.closest('ol');(list?.querySelectorAll('button')[next] as HTMLButtonElement)?.focus();}}} className={`relative flex min-h-36 w-full min-w-0 flex-col items-center justify-center rounded-xl border-2 p-2 transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-300 ${selectedSlot===index?'border-gold-500 bg-wood-800 shadow-inner':'border-line bg-wood-950/60 hover:border-line-strong'}`}>
      <span className="absolute left-2 top-1 text-xs text-cream-muted">{index+1}</span>
      {name&&creature?<Sprite choice={{speciesId:creature.speciesId,sourceName:creature.nickname,sprite:`/charmville/creatures/${name}-front.png`}}/>:<span className="flex h-16 items-center text-2xl text-cream-muted">—</span>}
      <span className="w-full truncate text-sm font-bold text-gold-300">{creature?.nickname??'Empty'}</span>
      <span className="text-xs text-cream-muted">{health?`Lv. ${health.level} · ${health.hp}/${health.maxHp}`:'Available slot'}</span>
      {creature&&<span className={`mt-1 rounded-full px-2 py-1 text-[11px] font-bold ${creature.following?'bg-forest-700 text-cream':'text-cream-muted'}`}>{creature.following?'Walking':'In party'}</span>}
     </button></li>;
    })}</ol>
    {onFormation&&<fieldset className="mt-4"><legend className="mb-2 text-xs font-bold uppercase tracking-wider text-cream-muted">Walking distance</legend><div className="grid grid-cols-2 gap-2">{(['close','relaxed'] as const).map(mode=><button key={mode} type="button" className={formation===mode?primary:button} aria-pressed={formation===mode} onClick={()=>{setFormation(mode);onFormation(mode);}}>{mode==='close'?'Close trail':'Relaxed trail'}</button>)}</div></fieldset>}
   </div>
   <div className="min-w-0 p-4">
    {selectedCreature&&roster?<>
     <div className="flex items-center gap-4 rounded-xl border border-line bg-forest-900 p-3">{selectedArt&&<Sprite choice={selectedArt}/>}<div className="min-w-0 flex-1"><p className="text-xs text-cream-muted">Party slot {selectedSlot+1}</p><h3 className="break-words text-xl font-bold text-gold-300">{selectedCreature.nickname}</h3><div className="mt-1 flex flex-wrap gap-1">{source?.types.filter((value,index,all)=>all.indexOf(value)===index).map(type=><span key={type} className="rounded border border-line-strong px-2 py-1 text-xs capitalize">{type.replace('TYPE_','').toLowerCase()}</span>)}</div></div></div>
     {selectedVitals&&<div className="my-3"><div className="mb-1 flex justify-between text-sm"><span>Level {selectedVitals.level}</span><span>HP {selectedVitals.hp} / {selectedVitals.maxHp}</span></div><meter aria-label="Companion HP" min={0} max={selectedVitals.maxHp} value={selectedVitals.hp} className="h-4 w-full accent-forest-600"/></div>}
     <button type="button" className={`${selectedCreature.following?button:primary} w-full`} disabled={busy} aria-pressed={selectedCreature.following} onClick={()=>void request({action:'roster-following',creatureId:selectedCreature.id,following:!selectedCreature.following,revision:roster.revision})}>{selectedCreature.following?'Return to party':'Walk with me'}</button>
     <p className="mt-2 text-center text-xs text-cream-muted">{selectedCreature.following?`${selectedCreature.nickname} is set to follow you.`:'Choose this companion to walk beside you.'} Other party members keep their own choice.</p>
     <div role="group" aria-label="Companion details" className="my-4 grid grid-cols-3 gap-1 rounded-lg border border-line p-1">{(['summary','care','organize'] as const).map(tab=><button key={tab} type="button" aria-pressed={detail===tab} onClick={()=>setDetail(tab)} className={`min-h-11 rounded-md px-2 text-sm font-bold capitalize focus-visible:outline-2 focus-visible:outline-gold-300 ${detail===tab?'bg-gold-500 text-wood-950':'text-cream-muted hover:text-cream'}`}>{tab}</button>)}</div>
     {detail==='summary'&&<div><dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm"><dt className="text-cream-muted">Role</dt><dd>{selectedCreature.id===partner?.id?'Starter partner':'Party companion'}</dd><dt className="text-cream-muted">Condition</dt><dd>{selectedVitals?(selectedVitals.hp===0?'Fainted':selectedVitals.hp===selectedVitals.maxHp?'Healthy':'Needs care'):'Loading…'}</dd><dt className="text-cream-muted">Travel</dt><dd>{selectedCreature.following?'Walking with you':'Resting in party'}</dd><dt className="text-cream-muted">Collection</dt><dd>{selectedCreature.acquisitionKind==='local-playtest'?'Test party':'Starter companion'}</dd></dl>{size&&<section aria-label="Species reference" className="mt-4 border-t border-line pt-3"><h4 className="text-sm font-bold text-gold-300">Species reference</h4><dl className="mt-2 grid grid-cols-2 gap-2 text-sm"><dt className="text-cream-muted">Height</dt><dd>{(size.heightDm/10).toFixed(1)} m</dd><dt className="text-cream-muted">Weight</dt><dd>{(size.weightHg/10).toFixed(1)} kg</dd></dl><p className="mt-2 text-xs text-cream-muted">Emerald species reference, not measurements of this individual companion.</p></section>}</div>}
     {detail==='care'&&<div>{selectedVitals&&<><button type="button" className={`${button} w-full`} disabled={busy||(!pendingFeedId&&(selectedVitals.hp===0||selectedVitals.hp>=selectedVitals.maxHp||vitals?.oranQuantity==='0'))||!!(pendingFeedId&&pendingFeedId!==selectedVitals.id)} onClick={()=>{pendingFeed.current??={action:'use-oran',requestId:crypto.randomUUID(),creatureId:selectedVitals.id,revision:selectedVitals.revision};setPendingFeedId(pendingFeed.current.creatureId);void request(pendingFeed.current);}}>{pendingFeedId?'Retry Oran feed':'Feed Oran Berry'}</button><p className="mt-2 text-xs text-cream-muted">{feedReason} {vitals?.oranQuantity??'0'} in your Satchel.</p></>}<RestPanel key={`rest:${wallet}`} wallet={wallet} creatureId={selectedCreature.id}/></div>}
     {detail==='organize'&&<label className="block text-sm">Assign party slot {selectedSlot+1}<select aria-label={`Assign party slot ${selectedSlot+1}`} className="mt-2 min-h-11 w-full rounded-lg border border-line bg-wood-900 px-2 text-cream" disabled={busy} value={selectedCreature.id} onChange={event=>{const next=slots.map((entry:Creature|null)=>entry?.id??null),chosen=event.target.value||null;for(let i=0;i<next.length;i++)if(chosen&&next[i]===chosen)next[i]=null;next[selectedSlot]=chosen;void request({action:'roster',revision:roster.revision,slots:next});}}><option value="">Empty</option>{roster.owned.map(entry=><option key={entry.id} value={entry.id}>{entry.nickname}</option>)}</select><span className="mt-2 block text-xs text-cream-muted">Moving a companion keeps its health and identity.</span></label>}
    </>:<div className="py-4"><h3 className="font-bold">{state?'Choose a companion':'Loading your companions…'}</h3>{state&&!homeReady&&!partner&&<button type="button" className={`${primary} mt-3`} disabled={busy} onClick={()=>{homeRequestId.current??=crypto.randomUUID();void request({action:'claim-home',requestId:homeRequestId.current});}}>Set up home</button>}{!partner&&<div className="mt-3 grid grid-cols-3 gap-2">{state?.choices.map(choice=><button key={choice.speciesId} aria-label={choice.sourceName} aria-pressed={selection?.speciesId===choice.speciesId} type="button" disabled={busy||!homeReady} className={`${button} min-w-0 px-1 text-xs`} onClick={()=>setSelection(choice)}><Sprite choice={choice}/>{choice.sourceName}</button>)}</div>}{roster&&partner&&<label className="mt-3 block text-sm">Fill this slot<select aria-label={`Assign party slot ${selectedSlot+1}`} className="mt-2 min-h-11 w-full rounded-lg border border-line bg-wood-900" value="" disabled={busy} onChange={event=>{const next=slots.map((entry:Creature|null)=>entry?.id??null),chosen=event.target.value;if(!chosen)return;for(let i=0;i<6;i++)if(next[i]===chosen)next[i]=null;next[selectedSlot]=chosen;void request({action:'roster',revision:roster.revision,slots:next});}}><option value="">Choose a party member</option>{roster.owned.map(entry=><option key={entry.id} value={entry.id}>{entry.nickname}</option>)}</select></label>}</div>}
    {selection&&!partner&&<div role="group" aria-label="Confirm companion" className="mt-3 rounded-lg border border-line p-3"><p className="mb-3 text-sm">Choose {selection.sourceName}? Your starter choice is permanent.</p><div className="flex gap-2"><button className={primary} type="button" disabled={busy} onClick={()=>void request({speciesId:selection.speciesId})}>Confirm companion</button><button className={button} type="button" disabled={busy} onClick={()=>setSelection(null)}>Back</button></div></div>}
   </div>
  </div>
  <footer className="border-t border-line px-4 py-3">{(busy||message)&&<p role="status" className="mb-2 text-sm text-cream-muted">{busy?'Saving and refreshing your party…':message}</p>}<div className="flex items-center justify-between gap-2"><span className="text-xs text-cream-muted">Saved to your game profile</span><button type="button" className="min-h-11 text-xs text-gold-300 underline underline-offset-4 disabled:opacity-50" disabled={busy} onClick={()=>void request()}>Refresh companion</button></div><details className="mt-1"><summary className="min-h-11 cursor-pointer py-3 text-sm text-cream-muted">Test party settings</summary><TestPartyPanel wallet={wallet} onChanged={refresh} onCreate={onTestProfile}/></details></footer>
 </section>;
}
