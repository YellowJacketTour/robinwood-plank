"use client";

import {useEffect, useState} from "react";

type Setup = {homeClaimed:boolean; companion:{id:string}|null};
type Props = {
  token:string; refreshKey:string; handle:string; busy:boolean;
  location:{active:boolean;ownerHandle:string|null;peers:Array<{profileId:string;handle:string}>}|null;
  profileId:string; onSetup:()=>void; onHome:()=>void; onPublic:()=>void; onFriends:()=>void;
};
const action="min-h-11 rounded-lg border border-line-strong bg-gold-500 px-4 py-2 font-bold text-wood-950 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";
export default function FirstSteps({token,refreshKey,handle,busy,location,profileId,onSetup,onHome,onPublic,onFriends}:Props){
  const [setup,setSetup]=useState<Setup|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=async()=>{
      try{
        const response=await fetch('/api/charmville/companions',{headers:{authorization:`Bearer ${token}`},cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal});
        if(!response.ok)throw Error('Setup unavailable');
        const data=await response.json();
        if(!controller.signal.aborted){setSetup(data);setError(false);}
      }catch{if(!controller.signal.aborted)setError(true);}
    };
    void refresh();const timer=setInterval(()=>void refresh(),30000);
    return()=>{controller.abort();clearInterval(timer);};
  },[token,refreshKey]);
  const atHome=Boolean(location?.active&&location.ownerHandle===handle);
  const inPublic=Boolean(location?.active&&!location.ownerHandle);
  const peers=location?.active?location.peers.filter(peer=>peer.profileId!==profileId):[];
  const title=!setup?'Getting your bearings':!setup.homeClaimed?'A place of your own':!setup.companion?'Choose your first companion':atHome?'Your homestead':inPublic?'Out in the shared meadow':'Return to your homestead';
  const text=!setup?'Checking your saved home and companion.':!setup.homeClaimed?'Claim your home in Party setup. Your supplies and progress belong to your PlankSpace account.':!setup.companion?'Choose a partner in Party, then select Walk with me to explore together.':atHome?'Start with the Oran beds. Grow berries, gather them into your Satchel, and care for your party. When you are ready, head to the shared meadow.':inPublic?'Meet signed-in players in this region. Wild encounters support shared battle viewing and invited assistance. Open Friends to see who is here.':'Enter your own home to grow berries and prepare your party before meeting others.';
  return <section aria-label="Your next adventure" className="mb-3 rounded-xl border border-line-strong bg-wood-900 p-3 sm:p-4">
    <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1"><p className="text-xs font-bold tracking-wide text-gold-300">{inPublic?'SHARED MEADOW':'FIRST STEPS'}</p><h2 className="mt-1 text-lg font-bold text-cream">{title}</h2><p className="mt-1 max-w-2xl text-sm text-cream-muted">{setup?.companion?(atHome?"Grow Oran Berries, care for your party, then meet other players.":inPublic?"Meet nearby players and assist in supported wild encounters.":text):text}</p></div>
      {setup&&<button className={action} disabled={busy||error} onClick={!setup.homeClaimed||!setup.companion?onSetup:atHome?onPublic:inPublic?onFriends:onHome}>{!setup.homeClaimed?'Set up my home':!setup.companion?'Choose a partner':atHome?'Visit the meadow':inPublic?'Players & travel':'Enter my home'}</button>}
    </div>
    {error&&<p role="status" className="mt-2 text-sm text-cream-muted">Your setup could not be checked. <button className="min-h-11 px-2 text-gold-300 underline focus-visible:outline-2 focus-visible:outline-gold-300" onClick={onSetup}>Open Party to retry</button></p>}
    <details className="mt-2 text-xs text-cream-muted"><summary className="min-h-11 cursor-pointer py-3">Journey & location details</summary>
    {setup?.companion&&<p className="text-sm">{text}</p>}
    <ol aria-label="Journey milestones" className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-xs text-cream-muted">
      <li>{setup?.homeClaimed?'✓':'1'} Home claimed</li><li>{setup?.companion?'✓':'2'} Partner chosen</li><li>{atHome?'●':'3'} Explore your home</li><li>{inPublic?'●':'4'} Shared meadow</li>
    </ol>
    {inPublic&&<p className="mt-2 text-xs text-cream-muted">{peers.length===0?'No other signed-in players are currently listed here.':`${peers.length} other ${peers.length===1?'player':'players'} here: ${peers.map(peer=>'@'+peer.handle).join(', ')}`}</p>}
    </details>
  </section>;
}
