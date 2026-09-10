"use client";

import Link from "next/link";
import {attachLocalPlaytestWallet} from "@/lib/charmville/local-playtest-client";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import { createGameAccountClient, type GameIdentity } from "@/lib/charmville/account-client";
import type { YardInventory } from "@/lib/charmville/inventory";
import ExchangePanel from "./exchange-panel";
import CompanionPanel from "./companion-panel";
import EncounterPanel from "./encounter-panel";
import {nativeEncounterProjection} from "@/lib/charmville/native-encounter-projection";
import {useNativeResources} from "./native-resources";
import {charmName} from "@/lib/charmville/item-display";
import {useNativeMovement} from "./native-movement";
import {useNativeContactObserver} from "./native-contact-observer";

type Presence = { profileId:string; regionId:string; ownerHandle:string|null; revision:string; expiresAt:string;
  active:boolean; peers:Array<{profileId:string;handle:string}>; reason:string|null };
type Session = { identity:GameIdentity; token:string };
const tabs=[['play','Play'],['companions','Party'],['inventory','Satchel'],['exchange','Exchange'],['friends','Friends']] as const;
type WorldTab=typeof tabs[number][0];
const button = "min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";

export default function World({localRuntime}:{localRuntime:boolean}) {
  const [identity,setIdentity]=useState<GameIdentity|null>(null);
  const [address,setAddress]=useState("");
  const [presence,setPresence]=useState<Presence|null>(null);
  const [inventory,setInventory]=useState<YardInventory|null>(null);
  const [visitor,setVisitor]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [camera,setCamera]=useState(false);
  const [fullscreen,setFullscreen]=useState(false);
  const [tab,setTab]=useState<WorldTab>('play');
  const frame=useRef<HTMLIFrameElement|null>(null);
  useNativeContactObserver(frame);
  const frameReady=useRef(false);
  const encounterSnapshot=useRef<unknown>(null);
  const updateEncounter=useCallback((snapshot:unknown|null)=>{
    encounterSnapshot.current=snapshot;
    if(frameReady.current)frame.current?.contentWindow?.postMessage(nativeEncounterProjection(snapshot),'http://localhost:3021');
  },[]);
  const followerSpecies=useRef(0);
  const partySpecies=useRef<number[]>([]);
  const partyCreatureIds=useRef<string[]>([]);
  const followerFormation=useRef<'close'|'relaxed'>('close');
  const updateFormation=useCallback((formation:'close'|'relaxed')=>{
    followerFormation.current=formation;
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:follower-formation',formation},'http://localhost:3021');
  },[]);
  const updateFollowers=useCallback((speciesIds:number[],creatureIds:string[]=[])=>{
    const members=speciesIds.map((speciesId,index)=>({speciesId,id:creatureIds[index]??''})).filter(member=>[277,280,283,25,133,286].includes(member.speciesId)).slice(0,6);
    partySpecies.current=members.map(member=>member.speciesId);
    partyCreatureIds.current=members.map(member=>member.id);
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:party-followers',speciesIds:partySpecies.current,creatureIds:partyCreatureIds.current},'http://localhost:3021');
  },[]);
  const updateFollower=useCallback((speciesId:number)=>{
    followerSpecies.current=[277,280,283,25,133,286].includes(speciesId)?speciesId:0;
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:follower',speciesId:followerSpecies.current},'http://localhost:3021');
  },[]);
  const pendingPanel=useRef<'charmdex'|'voice'|null>(null);
  const session=useRef<Session|null>(null);
  const wallet=useRef<string|null>(null);
  const generation=useRef(0);
  const inFlight=useRef<AbortController|null>(null);
  const location=useRef<Presence|null>(null);
  const [accountClient]=useState(()=>createGameAccountClient());
  const mounted=useRef(true);
  const signingIn=useRef(false);
  const movementStatus=useNativeMovement(frame,session,identity?.profileId,presence?.active?presence.regionId:undefined);

  const clear=useCallback(()=>{
    ++generation.current; inFlight.current?.abort(); inFlight.current=null;
    accountClient.disconnect(); session.current=null; location.current=null;
    updateEncounter(null);
    updateFollower(0);
    updateFollowers([]);
    pendingPanel.current=null;
    frameReady.current=false;
  },[accountClient,updateFollower,updateFollowers,updateEncounter]);

  const load=useCallback(async(destination?:{destination:"home"|"public";handle?:string})=>{
    const account=session.current;
    if(!account)return;
    inFlight.current?.abort();
    const controller=new AbortController();inFlight.current=controller;
    const version=generation.current;
    setBusy(true);setMessage("");
    const request=async(path:string,body?:object)=>{
      const response=await fetch(path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${account.token}`,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,
        cache:"no-store",credentials:"same-origin",mode:"same-origin",redirect:"error",signal:controller.signal});
      const data=await response.json();
      if(!response.ok)throw Object.assign(new Error(data.error??"Your world could not be refreshed."),{status:response.status});
      return data;
    };
    try {
      const next=await request("/api/charmville/world/presence",destination?{...destination,revision:location.current?.revision??"0"}:undefined) as Presence;
      if(controller.signal.aborted||version!==generation.current)return;
      // Commit admission independently: an inventory read failure must not hide a successful move.
      location.current=next;setPresence(next);
      const yard=await request(`/api/charmville/${encodeURIComponent(account.identity.handle)}`) as {inventory:YardInventory|null};
      if(controller.signal.aborted||version!==generation.current)return;
      setInventory(yard.inventory);
      if(next.reason==="permission-revoked")setMessage("Your home invitation changed. Return to the public meadow.");
    }catch(error){
      if(!controller.signal.aborted&&version===generation.current){
        if((error as {status?:number}).status===401){
          clear();setIdentity(null);setAddress("");setPresence(null);setInventory(null);setCamera(false);setBusy(false);
          setMessage("Your session expired. Sign in again; your saved progress is safe.");return;
        }
        // A rejected renewal must not leave a revoked home looking occupied.
        if(destination&&[403,409].includes((error as {status?:number}).status??0)){
          try {
            const current=await request("/api/charmville/world/presence") as Presence;
            if(!controller.signal.aborted&&version===generation.current){location.current=current;setPresence(current);}
          }catch{/* Preserve the original rejection; next refresh can retry. */}
        }
        if(!controller.signal.aborted&&version===generation.current)setMessage(error instanceof Error?error.message:"World unavailable.");
      }
    }
    finally{if(!controller.signal.aborted&&version===generation.current){inFlight.current=null;setBusy(false);}}
  },[clear]);

  const openTestProfile=useCallback(async(test:{wallet:string;token:string})=>{
    if(!localRuntime||!['localhost','127.0.0.1'].includes(window.location.hostname)||!/^0x[a-f0-9]{40}$/.test(test.wallet)||! /^[a-f0-9]{64}$/.test(test.token))throw Error('Local test profile unavailable');
    const verified=await accountClient.connect(test.token);
    clear();
    localStorage.setItem(`plankspace-session:${test.wallet}`,test.token);
    localStorage.setItem('plankspace-last-verified-wallet',test.wallet);
    attachLocalPlaytestWallet(test.wallet);
    wallet.current=test.wallet;session.current={identity:verified,token:test.token};
    setAddress(test.wallet);setIdentity(verified);setPresence(null);setInventory(null);setCamera(true);setTab('companions');
    await load();
  },[localRuntime,accountClient,clear,load]);
  const resourceStatus=useNativeResources(frame,session,identity?.profileId,presence?.active?presence.regionId:undefined,load);

  const restore=useCallback(async(token:string,version:number)=>{
    if(version!==generation.current)return;
    const account=await accountClient.connect(token);
    if(version!==generation.current)return;
    session.current={identity:account,token};setIdentity(account);
    setAddress(wallet.current??"");
    if(localRuntime&&['localhost','127.0.0.1'].includes(window.location.hostname))setCamera(true);
    await load();
  },[accountClient,load,localRuntime]);

  useEffect(()=>{
    let disposed=false;
    const url=new URL(window.location.href);
    let panel=url.searchParams.get('panel');
    if(panel==='garden'){panel='play';url.searchParams.set('panel','play');window.history.replaceState(window.history.state,'',url);}
    if(tabs.some(([id])=>id===panel))void Promise.resolve().then(()=>{if(!disposed)setTab(panel as WorldTab);});
    return()=>{disposed=true;};
  },[]);

  useEffect(()=>{
    const returnToMenus=(event:MessageEvent)=>{
      if(event.origin!=='http://localhost:3021'||event.source!==frame.current?.contentWindow)return;
      if(event.data?.type==='charmville:follower-ready'){updateFollower(followerSpecies.current);updateFollowers(partySpecies.current,partyCreatureIds.current);updateFormation(followerFormation.current);updateEncounter(encounterSnapshot.current);return;}
      if(event.data?.type!=='charmville:account-menu')return;
      const panel=event.data.panel;
      if(!tabs.some(([id])=>id===panel)||panel==='play')return;
      if(document.fullscreenElement===frame.current)void document.exitFullscreen().catch(()=>{});
      setTab(panel);
      requestAnimationFrame(()=>{const selected=document.getElementById(`tab-${panel}`);selected?.focus();selected?.scrollIntoView({block:'start'});});
    };
    window.addEventListener('message',returnToMenus);
    return()=>window.removeEventListener('message',returnToMenus);
  },[updateFollower,updateFollowers,updateFormation,updateEncounter]);

  useEffect(()=>{
    const changed=()=>setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange",changed);
    return()=>document.removeEventListener("fullscreenchange",changed);
  },[]);

  useEffect(()=>{
    let disposed=false;
    mounted.current=true;
    const stop=subscribePlankLoveWalletState(state=>{
      if(disposed)return;
      const address=state.address?.toLowerCase()??null;
      if(address===wallet.current)return;
      wallet.current=address;clear();
      const version=generation.current;
      setIdentity(null);setAddress("");setPresence(null);setInventory(null);setCamera(false);setBusy(signingIn.current);setMessage(signingIn.current?"Wallet connection changed. Please finish connecting or try again.":"");
      if(address&&!signingIn.current)void savedWalletProof(address).then(proof=>{
        if(proof.sessionToken&&!disposed)return restore(proof.sessionToken,version);
      }).catch(error=>{if(!disposed&&version===generation.current)setMessage(error instanceof Error?error.message:"Sign in again.");});
    });
    return()=>{disposed=true;mounted.current=false;wallet.current=null;clear();stop();};
  },[clear,restore]);

  useEffect(()=>{
    const timer=setInterval(()=>{
      if(document.hidden||inFlight.current||!session.current)return;
      const current=location.current;
      if(current?.active)void load(current.ownerHandle?{destination:"home",handle:current.ownerHandle}:{destination:"public"});
      else void load();
    },30000);
    return()=>clearInterval(timer);
  },[load]);

  async function enter(){
    if(signingIn.current)return;
    signingIn.current=true;
    setBusy(true);setMessage("");
    let version=generation.current;
    try {
      const address=(await connectPlankLoveWallet()).toLowerCase();
      if(!mounted.current)return;
      if(wallet.current&&wallet.current!==address)throw new Error("Your wallet changed. Try again.");
      wallet.current=address;clear();version=generation.current;
      const proof=await walletProof(address,"profile:read",address,{wallet:address});
      await restore(proof.sessionToken,version);
    }catch(error){if(version===generation.current)setMessage(error instanceof Error?error.message:"Could not sign in.");}
    finally{signingIn.current=false;if(mounted.current)setBusy(false);}
  }

  function visit(){
    const handle=visitor.trim().replace(/^@/,"").toLowerCase();
    if(!/^[a-z0-9_]{1,40}$/.test(handle)){setMessage("Use a player handle: up to 40 letters, numbers or underscores.");return;}
    void load({destination:"home",handle});
  }

  function toggleFullscreen(){
    if(typeof document.documentElement.requestFullscreen!=="function"){setMessage("Fullscreen is unavailable in this browser.");return;}
    const action=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
    void action.catch(()=>setMessage("Fullscreen is unavailable in this browser."));
  }

  function sendPanel(){
    if(!pendingPanel.current||!frameReady.current||!frame.current?.contentWindow)return;
    frame.current.contentWindow.postMessage({type:'charmville:open-panel',panel:pendingPanel.current},'http://localhost:3021');
    pendingPanel.current=null;
  }
  function openPanel(panel:'charmdex'|'voice'){
    if(!localRuntime||!["localhost","127.0.0.1"].includes(window.location.hostname)){setMessage("The adventure tools are available on the local development machine.");return;}
    pendingPanel.current=panel;setTab('play');
    if(camera)sendPanel();else {frameReady.current=false;setCamera(true);}
  }

  return <main data-market-shell className="min-h-screen bg-wood-950 p-3 text-cream sm:p-5">
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-xs font-bold tracking-widest text-cream-muted">CHARMVILLE</p><h1 className="font-display text-xl text-gold-300">Charmdex</h1></div>
      <nav aria-label="World shortcuts" className="flex flex-wrap gap-2"><button className={button} aria-pressed={fullscreen} onClick={toggleFullscreen}>Toggle fullscreen</button><Link className={button} href="/plankspace">Lumberyard</Link></nav>
    </header>
    {!identity?<section className="rounded-xl border border-line bg-panel p-5"><h2 className="font-display text-xl">Bring your account into the world</h2><p className="my-3 text-cream-muted">Sign in with your approved PlankSpace profile. Your saved inventory stays with your account.</p><button className={button} disabled={busy} onClick={enter}>{busy?"Signing in…":"Connect and sign in"}</button><Link className="ml-4 text-gold-300" href="/charmville/start">Create or finish your profile</Link></section>:
    <>
    <div className="sticky top-0 z-10 mb-3 overflow-hidden rounded-2xl border-2 border-line-strong bg-wood-900 p-2 shadow-lg">
      <div role="tablist" aria-label="Game and account" className="flex gap-1 overflow-x-auto">
        {tabs.map(([id,label],index)=><button key={id} id={`tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`panel-${id}`} tabIndex={tab===id?0:-1}
          className={`min-h-12 min-w-16 flex-1 rounded-lg px-2 py-2 text-xs font-bold focus-visible:outline-2 focus-visible:outline-gold-300 sm:text-sm ${tab===id?'bg-gold-500 text-wood-950':'text-gold-300 hover:bg-panel-soft'}`}
          onClick={()=>{setTab(id);if(id==='play')requestAnimationFrame(()=>frame.current?.focus());}} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();setTab(tabs[next][0]);document.getElementById(`tab-${tabs[next][0]}`)?.focus();}}>{label}</button>)}
      </div>
      <p className="mt-2 truncate border-t border-line px-2 pt-2 text-xs text-cream-muted">@{identity.handle} · {presence?.active?(presence.ownerHandle?`Home of @${presence.ownerHandle}`:'Public meadow'):'Choose a location in Friends'}</p>
      {localRuntime&&<div className="mt-2 flex flex-wrap gap-2"><button className="min-h-11 rounded-lg border border-line px-3 text-sm text-gold-300" onClick={()=>openPanel('charmdex')}>Discover charms</button><button className="min-h-11 rounded-lg border border-line px-3 text-sm text-gold-300" onClick={()=>openPanel('voice')}>Voice note</button></div>}
    </div>
    <div className={`grid gap-4 ${tab!=='play'?'xl:grid-cols-[minmax(320px,1fr)_minmax(0,1.2fr)]':''}`}>
      <section id="panel-play" role="tabpanel" aria-labelledby="tab-play" className={`min-w-0 self-start rounded-xl border border-line bg-panel p-3 ${tab!=='play'?'hidden xl:block':''}`} aria-label="Native adventure camera">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-display text-xl text-gold-300">Adventure</h2><span className="text-xs text-cream-muted">Enter · Game menus</span></div>
        <p role="status" className="mb-2 text-sm text-cream-muted">{resourceStatus||movementStatus}</p>
        <details className="mb-2 text-xs text-cream-muted"><summary className="cursor-pointer py-2">What saves with your account</summary><p className="py-2">{presence?.active?'Your movement, Oran harvests and companion health save to your account. Capture and combat rewards are not available yet.':'Join a location in Friends to save movement and grow Oran Berries for your Satchel and Exchange.'}</p></details>
        {camera?<iframe ref={frame} onLoad={()=>{frameReady.current=true;frame.current?.contentWindow?.postMessage({type:'charmville:account-peers',active:true,peers:[]},'http://localhost:3021');frame.current?.contentWindow?.postMessage({type:'charmville:host-ready'},'http://localhost:3021');updateFollower(followerSpecies.current);updateFollowers(partySpecies.current,partyCreatureIds.current);updateFormation(followerFormation.current);updateEncounter(encounterSnapshot.current);sendPanel();}} title="Charmville native reference adventure" src="http://localhost:3021/charmville/tutorial/" sandbox="allow-scripts allow-same-origin allow-downloads" allow="cross-origin-isolated; fullscreen; gamepad; keyboard-map; microphone" allowFullScreen referrerPolicy="no-referrer" className="h-[72vh] min-h-96 w-full rounded-lg border border-line" />:
          <div className="flex min-h-96 items-center justify-center rounded-lg border border-line bg-panel-soft p-6">{localRuntime?<button className={button} onClick={()=>{if(["localhost","127.0.0.1"].includes(window.location.hostname))setCamera(true);else setMessage("The native runtime is currently available on the local development machine.");}}>Load adventure</button>:<p className="text-cream-muted">Native hosting is being connected. Account locations and inventory are available independently.</p>}</div>}
        {address&&<EncounterPanel key={`encounter:${address}`} wallet={address} active={tab==='play'} onSnapshot={updateEncounter}/>}
      </section>
      <aside className={tab==='play'?'hidden':'space-y-4 rounded-2xl border-2 border-line-strong bg-wood-900 p-3'} aria-label="Account world controls"><div className="flex items-center justify-between border-b border-line pb-2"><h2 className="font-display text-xl text-gold-300">{tabs.find(([id])=>id===tab)?.[1]}</h2><button className={button} onClick={()=>{setTab('play');requestAnimationFrame(()=>frame.current?.focus());}}>Return to play</button></div>
        <div id="panel-friends" role="tabpanel" aria-labelledby="tab-friends" hidden={tab!=='friends'} className="space-y-4">
        <section className="rounded-xl border border-line bg-panel p-4"><h2 className="font-display text-xl">@{identity.handle}</h2><p className="mt-2 text-cream-muted">{presence?.active?(presence.ownerHandle?`At @${presence.ownerHandle}’s home`:"In the public meadow"):"Choose where to join"}</p>
          <div className="my-3 flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={()=>void load({destination:"home",handle:identity.handle})}>Go home</button><button className={button} disabled={busy} onClick={()=>void load({destination:"public"})}>Public meadow</button></div>
          <form onSubmit={e=>{e.preventDefault();visit();}}><label className="block text-sm" htmlFor="visit-handle">Visit a friend</label><input id="visit-handle" value={visitor} maxLength={visitor.startsWith("@")?41:40} onChange={e=>setVisitor(e.target.value)} className="my-2 min-h-11 w-full rounded-lg border border-line bg-panel-soft px-3" placeholder="Their player handle"/><button className={button} disabled={busy||!visitor.trim()}>Visit home</button></form>
          <p className="mt-3 text-sm text-cream-muted">Your friend must invite you. Visiting does not grant permission to take items or build.</p>
        </section>
        <section className="rounded-xl border border-line bg-panel p-4" aria-label="Players here"><h2 className="font-display text-xl">Players here</h2>{presence?.active?<><p className="my-2 text-sm text-cream-muted">Account presence · refreshed every 30 seconds</p><ul className="space-y-2"><li>You · @{identity.handle}</li>{presence.peers.filter(peer=>peer.profileId!==identity.profileId).map(peer=><li key={peer.profileId}>@{peer.handle}</li>)}</ul></>:<p className="mt-2 text-cream-muted">Join a location to meet other signed-in players.</p>}</section>
        <button className={button} disabled={busy} onClick={()=>void load()}>Refresh account</button>
        </div>
        <div id="panel-inventory" role="tabpanel" aria-labelledby="tab-inventory" hidden={tab!=='inventory'}>
        <section className="rounded-xl bg-panel p-4" aria-label="Saved inventory">{inventory?<><p className="my-2 text-gold-300">{inventory.grain} Grain</p><h3 className="mt-3 font-bold">Gameplay supplies</h3><ul>{inventory.seeds.map(stack=><li key={stack.face}>{charmName(stack.face)} seed × {stack.qty}</li>)}</ul><h3 className="mt-3 font-bold">Charm Satchel</h3>{inventory.faces.length?<ul>{inventory.faces.map(stack=><li key={stack.face} className="flex items-center gap-2">{stack.face==='oran-berry'&&<Image src="/charmville/items/oran-berry.png" alt="" width={24} height={24} className="[image-rendering:pixelated]"/>}{charmName(stack.face)} × {stack.qty}</li>)}</ul>:<p className="text-cream-muted">No charms yet.</p>}</>:<div><p className="mb-3 text-cream-muted">Set up your home to start collecting supplies and charms.</p><button className={button} onClick={()=>setTab('companions')}>Open Party setup</button></div>}<button className={`${button} mt-3`} disabled={busy} onClick={()=>void load()}>Refresh account</button></section>
        <p className="mt-2 text-sm text-cream-muted">Account inventory. The reference adventure’s equipment menu is separate.</p>
        </div>
        <div id="panel-companions" role="tabpanel" aria-labelledby="tab-companions" hidden={tab!=='companions'}>{address&&<CompanionPanel key={`companion:${address}`} wallet={address} handle={identity.handle} onHomeReady={load} onFollower={updateFollower} onFollowers={updateFollowers} onFormation={updateFormation} onTestProfile={openTestProfile} onPlay={()=>{setTab('play');if(localRuntime&&['localhost','127.0.0.1'].includes(window.location.hostname))setCamera(true);requestAnimationFrame(()=>frame.current?.focus());}} />}</div>
        <div id="panel-exchange" role="tabpanel" aria-labelledby="tab-exchange" hidden={tab!=='exchange'}>{address&&<ExchangePanel key={`${address}:${identity.handle}`} wallet={address} handle={identity.handle} onChanged={()=>void load()} />}</div>
      </aside>
    </div></>}
    {message&&<p role="status" className="mt-4 rounded-xl border border-line bg-panel p-4">{message}</p>}
  </main>;
}
