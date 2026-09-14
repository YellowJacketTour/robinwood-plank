"use client";

import {useEffect, useState} from "react";
import {cropLessons} from "@/lib/charmville/journey-lessons";
import type {YardInventory} from "@/lib/charmville/inventory";
import FamilyGiftPanel from './family-gift-panel';

type Setup = {token:string;homeClaimed:boolean; companion:boolean; completed:string[]};
type Props = {
  token:string; refreshKey:string; handle:string; busy:boolean; inventory:YardInventory|null; onSatchel:()=>void; onOpenFreshSatchel?:()=>Promise<void>; onExchange:()=>void;
  location:{active:boolean;ownerHandle:string|null;peers:Array<{profileId:string;handle:string}>}|null;
  profileId:string; onSetup:()=>void; onHome:()=>void; onPublic:()=>void; onFriends:()=>void; onPlay:()=>void;
};
const action="min-h-11 rounded-lg border border-line-strong bg-gold-500 px-4 py-2 font-bold text-wood-950 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
const secondary="min-h-11 rounded-lg border border-line-strong bg-forest-800 px-4 py-2 font-bold text-cream hover:bg-forest-700 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
export default function FirstSteps({token,refreshKey,handle,busy,location,profileId,onSetup,onHome,onPublic,onFriends,onPlay,inventory,onSatchel,onOpenFreshSatchel,onExchange}:Props){
  const [snapshot,setSetup]=useState<Setup|null>(null);
  const setup=snapshot?.token===token?snapshot:null;
  const [error,setError]=useState(false);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    let pending=false;
    const refresh=async()=>{
      if(pending)return;
      pending=true;
      try{
        const response=await fetch('/api/charmville/journey',{headers:{authorization:`Bearer ${token}`},cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal});
        if(!response.ok)throw Error('Setup unavailable');
        const data=await response.json();
        if(data.version!==1||!Array.isArray(data.completed)||!data.completed.every((key:unknown)=>typeof key==='string'))throw Error('Journey unavailable');
        if(!controller.signal.aborted){setSetup({token,homeClaimed:data.completed.includes('home.claimed'),companion:data.completed.includes('partner.chosen'),completed:data.completed});setError(false);}
      }catch{if(!controller.signal.aborted)setError(true);}
      finally{pending=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),10000);
    return()=>{controller.abort();clearInterval(timer);};
  },[token,refreshKey,retry]);
  const atHome=Boolean(location?.active&&location.ownerHandle===handle);
  const inPublic=Boolean(location?.active&&!location.ownerHandle);
  const visiting=Boolean(location?.active&&location.ownerHandle&&!atHome);
  const berries=inventory?inventory.faces.find(stack=>stack.face==='oran-berry')?.qty??'0':null;
  const hearts=inventory?inventory.faces.find(stack=>stack.face==='burning-heart')?.qty??'0':null;
  const lessons=cropLessons(setup?.completed??[]);
  const harvested=lessons.harvested;
  // Receipts describe lessons already completed, not the state of any current bed.
  const nextLesson=!lessons.tilled
    ?{title:'Prepare your first bed',text:'Approach an empty planting bed and prepare the soil. Follow the action shown for that bed.'}
    :!lessons.planted
    ?{title:'Plant your first seed',text:'Soil preparation learned. Find a prepared bed and plant one of your seeds. If the bed has changed, follow its current action first.'}
    :!lessons.watered
    ?{title:'Water your first plant',text:'Planting learned. Approach a planted bed and water it. Follow the bed’s current action if it needs preparing or planting again.'}
    :{title:'Gather your first harvest',text:'Watering learned. Check a planting bed for a ripe crop and gather them when ready. A growing plant needs time; an empty bed needs planting again.'};
  const peers=location?.active?location.peers.filter(peer=>peer.profileId!==profileId):[];
  const title=!setup?'Getting your bearings':!setup.homeClaimed?'A place of your own':!setup.companion?'Choose your first companion':atHome?(harvested?'First harvest complete':nextLesson.title):inPublic?'Out in the shared meadow':'Return to your homestead';
  const text=!setup?'Checking your saved home and companion.':!setup.homeClaimed?'Claim your home in Party setup. Your supplies and progress belong to your PlankSpace account.':!setup.companion?'Choose a partner in Party, then select Walk with me to explore together.':atHome?'Start with your planting beds. Grow crops and gather them into your Satchel. When you are ready, head to the shared meadow.':inPublic?'Meet signed-in players in this region. Open Friends to meet people here, or return home to tend your garden. Your journey does not require a battle.':'Enter your own home to grow crops and prepare your party before meeting others.';
  return <section data-market-shell aria-label="Your next adventure" className="mb-3 rounded-xl border border-line-strong bg-forest-900 p-3 text-cream sm:p-4">
    <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1"><p className="text-xs font-bold tracking-wide text-gold-300">{inPublic?'SHARED MEADOW':'FIRST STEPS'}</p><h2 className="mt-1 text-lg font-bold text-cream">{title}</h2><p className="mt-1 max-w-2xl text-sm text-cream-muted">{setup?.companion?(atHome?(harvested?'You have gathered your first harvest. Care for your companions, keep growing, or visit the shared meadow.':nextLesson.text):inPublic?"Meet nearby players, visit friends, and bring what you learn back to your garden.":text):text}</p></div>
      {setup&&<button type="button" className={action} disabled={busy||error} onClick={!setup.homeClaimed||!setup.companion?onSetup:onPlay}>{!setup.homeClaimed?'Set up my home':!setup.companion?'Choose a partner':atHome&&!harvested?'Return to the beds':'Back to adventure'}</button>}
    </div>
    {error&&<p role="status" className="mt-2 text-sm text-cream-muted">Your setup could not be checked. <button className="min-h-11 px-2 text-gold-300 underline focus-visible:outline-2 focus-visible:outline-gold-300" onClick={()=>setRetry(value=>value+1)}>Retry journey</button></p>}
    <p className="mt-2 text-sm text-cream-muted">{berries===null?'Checking your Satchel…':`In your Satchel: ${berries} Oran Berries · ${hearts} Burning Hearts.`} {harvested&&"Your first harvest stays completed after using or trading them."} <button className="min-h-11 px-2 text-gold-300 underline focus-visible:outline-2 focus-visible:outline-gold-300" onClick={onSatchel}>Open Satchel</button></p>
    {setup&&<nav aria-label="Places to go" className="mt-3 border-y border-line py-3">
      <p className="mb-3 text-xs text-cream-muted">{atHome?'You are home.':inPublic?'You are in the shared meadow.':visiting?`You are visiting @${location?.ownerHandle}.`:'Choose a place to enter the world.'} {busy&&<span role="status">Travelling…</span>}</p>
      <div className="grid gap-3 sm:grid-cols-2">
       <div className="flex flex-col items-start gap-1">
        <span className="font-display text-base text-gold-300">Your home</span>
        <p className="mb-1 text-xs text-cream-muted">Tend your beds and prepare your party.</p>
        <button type="button" className={secondary} disabled={busy||error||atHome} aria-current={atHome?'location':undefined} onClick={setup.homeClaimed?onHome:onSetup}>{atHome?'You are here':setup.homeClaimed?'Return home':'Set up my home'}</button>
       </div>
       <div className="flex flex-col items-start gap-1">
        <span className="font-display text-base text-gold-300">Shared meadow</span>
        <p className="mb-1 text-xs text-cream-muted">Meet players here, then return home whenever you like.</p>
        <button type="button" className={secondary} disabled={busy||error||inPublic||!setup.homeClaimed} aria-current={inPublic?'location':undefined} onClick={onPublic}>{inPublic?'You are here':'Visit the meadow'}</button>
       </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
       <button type="button" className={secondary} disabled={busy||error} onClick={onFriends}>Find &amp; visit friends</button>
       <button type="button" className={secondary} disabled={busy||error} onClick={onExchange}>Open Exchange</button>
      </div>
    </nav>}
    {harvested&&<p className="mt-2 text-sm text-cream-muted">Your harvest is yours to keep or use in supported activities. Check the Exchange for tradable items. Keep some supplies for your next planting.</p>}
    {setup?.homeClaimed&&<FamilyGiftPanel key={token} token={token} onSatchel={onOpenFreshSatchel??onSatchel}/>}
    <details className="mt-2 text-xs text-cream-muted"><summary className="min-h-11 cursor-pointer py-3">Journey & location details</summary>
    {setup?.companion&&<p className="text-sm">{text}</p>}
    <p className="mt-3">{setup?'Completed lessons stay in your journal. Check each bed in the world for its current condition.':'Your saved lessons have not loaded yet.'}</p>
    <ol aria-label="Journey milestones" aria-busy={!setup&&!error} className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-xs text-cream-muted">
      {[['home.claimed','Home claimed'],['partner.chosen','Partner chosen'],['home.soil.tilled','Soil prepared'],['home.crop.planted','Seed planted'],['home.crop.watered','Plant watered'],['home.crop.harvested','First harvest']].map(([key,label])=><li key={key}><span aria-hidden="true">{!setup?'…':(setup.completed.includes(key)||(key==='home.crop.planted'&&lessons.planted)||(key==='home.crop.watered'&&lessons.watered)||(key==='home.crop.harvested'&&lessons.harvested))?'✓':'○'}</span> {label}<span className="sr-only">{!setup?' — status unknown':(setup.completed.includes(key)||(key==='home.crop.planted'&&lessons.planted)||(key==='home.crop.watered'&&lessons.watered)||(key==='home.crop.harvested'&&lessons.harvested))?' — completed':' — not completed'}</span></li>)}
    </ol>
    {inPublic&&<p className="mt-2 text-xs text-cream-muted">{peers.length===0?'No other signed-in players are currently listed here.':`${peers.length} other ${peers.length===1?'player':'players'} here: ${peers.map(peer=>'@'+peer.handle).join(', ')}`}</p>}
    </details>
  </section>;
}
