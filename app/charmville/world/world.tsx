"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import { createGameAccountClient, type GameIdentity } from "@/lib/charmville/account-client";
import type { YardInventory } from "@/lib/charmville/inventory";
import ExchangePanel from "./exchange-panel";
import CompanionPanel from "./companion-panel";

type Presence = { profileId:string; regionId:string; ownerHandle:string|null; revision:string; expiresAt:string;
  active:boolean; peers:Array<{profileId:string;handle:string}>; reason:string|null };
type Session = { identity:GameIdentity; token:string };
const tabs=[['play','Play'],['inventory','Inventory'],['companions','Companions'],['exchange','Exchange'],['friends','Friends']] as const;
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
  const frameReady=useRef(false);
  const pendingPanel=useRef<'charmdex'|'voice'|null>(null);
  const session=useRef<Session|null>(null);
  const wallet=useRef<string|null>(null);
  const generation=useRef(0);
  const inFlight=useRef<AbortController|null>(null);
  const location=useRef<Presence|null>(null);
  const [accountClient]=useState(()=>createGameAccountClient());
  const mounted=useRef(true);

  const clear=useCallback(()=>{
    ++generation.current; inFlight.current?.abort(); inFlight.current=null;
    accountClient.disconnect(); session.current=null; location.current=null;
    pendingPanel.current=null;
    frameReady.current=false;
  },[accountClient]);

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

  const restore=useCallback(async(token:string,version:number)=>{
    if(version!==generation.current)return;
    const account=await accountClient.connect(token);
    if(version!==generation.current)return;
    session.current={identity:account,token};setIdentity(account);
    setAddress(wallet.current??"");
    await load();
  },[accountClient,load]);

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
      setIdentity(null);setAddress("");setPresence(null);setInventory(null);setCamera(false);setBusy(false);setMessage("");
      if(address)void savedWalletProof(address).then(proof=>{
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
    finally{if(version===generation.current)setBusy(false);}
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
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm text-gold-300">Charmville</p><h1 className="font-display text-2xl">Your world, together</h1></div>
      <nav aria-label="World shortcuts" className="flex flex-wrap gap-2"><button className={button} aria-pressed={fullscreen} onClick={toggleFullscreen}>Toggle fullscreen</button><Link className={button} href="/charmville/start">Home & visitors</Link><Link className={button} href="/plankspace">Lumberyard</Link></nav>
    </header>
    {!identity?<section className="rounded-xl border border-line bg-panel p-5"><h2 className="font-display text-xl">Bring your account into the world</h2><p className="my-3 text-cream-muted">Sign in with your approved PlankSpace profile. Your saved inventory stays with your account.</p><button className={button} disabled={busy} onClick={enter}>{busy?"Signing in…":"Connect and sign in"}</button><Link className="ml-4 text-gold-300" href="/charmville/start">Create or finish your profile</Link></section>:
    <>
    <div className="sticky top-0 z-10 mb-3 rounded-xl border border-line bg-wood-950 p-2">
      <div role="tablist" aria-label="Game and account" className="grid grid-cols-5 gap-1">
        {tabs.map(([id,label],index)=><button key={id} id={`tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`panel-${id}`} tabIndex={tab===id?0:-1}
          className={`min-h-12 rounded-lg px-1 py-2 text-[0.6875rem] font-bold focus-visible:outline-2 focus-visible:outline-gold-300 sm:text-sm ${tab===id?'bg-gold-500 text-wood-950':'text-gold-300 hover:bg-panel-soft'}`}
          onClick={()=>setTab(id)} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();setTab(tabs[next][0]);document.getElementById(`tab-${tabs[next][0]}`)?.focus();}}>{label}</button>)}
      </div>
      <p className="mt-1 truncate px-1 text-xs text-cream-muted">@{identity.handle} · {presence?.active?(presence.ownerHandle?`Home of @${presence.ownerHandle}`:'Public meadow'):'Choose a location in Friends'}</p>
      {localRuntime&&<div className="mt-2 flex gap-2"><button className="min-h-10 rounded-lg border border-line px-3 text-sm text-gold-300" onClick={()=>openPanel('charmdex')}>Charmdex</button><button className="min-h-10 rounded-lg border border-line px-3 text-sm text-gold-300" onClick={()=>openPanel('voice')}>Voice note</button></div>}
    </div>
    <div className={`grid gap-4 ${tab!=='play'?'xl:grid-cols-[minmax(0,1fr)_22rem]':''}`}>
      <section id="panel-play" role="tabpanel" aria-labelledby="tab-play" className={`min-w-0 self-start rounded-xl border border-line bg-panel p-3 ${tab!=='play'?'hidden xl:block':''}`} aria-label="Native adventure camera">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-xl">Adventure camera</h2><span className="text-sm text-cream-muted">Reference map · separate movement</span></div>
        <p className="mb-3 text-sm text-cream-muted">Account travel and players appear in the panel. This camera still uses the reference map; movement and harvests here do not change your saved inventory.</p>
        {camera?<iframe ref={frame} onLoad={()=>{frameReady.current=true;sendPanel();}} title="Charmville native reference adventure" src="http://localhost:3021/charmville/tutorial/" sandbox="allow-scripts allow-same-origin allow-downloads" allow="cross-origin-isolated; fullscreen; gamepad; keyboard-map; microphone" allowFullScreen referrerPolicy="no-referrer" className="h-[72vh] min-h-96 w-full rounded-lg border border-line" />:
          <div className="flex min-h-96 items-center justify-center rounded-lg border border-line bg-panel-soft p-6">{localRuntime?<button className={button} onClick={()=>{if(["localhost","127.0.0.1"].includes(window.location.hostname))setCamera(true);else setMessage("The native runtime is currently available on the local development machine.");}}>Open adventure camera</button>:<p className="text-cream-muted">Native hosting is being connected. Account locations and inventory are available independently.</p>}</div>}
      </section>
      <aside className={tab==='play'?'hidden':'space-y-4'} aria-label="Account world controls">
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
        <section className="rounded-xl border border-line bg-panel p-4" aria-label="Saved inventory"><h2 className="font-display text-xl">Saved inventory</h2>{inventory?<><p className="my-2 text-gold-300">{inventory.grain} Grain</p><h3 className="mt-3 font-bold">Gameplay supplies</h3><ul>{inventory.seeds.map(stack=><li key={stack.face}>{stack.face} seed × {stack.qty}</li>)}</ul><h3 className="mt-3 font-bold">Charm Satchel</h3>{inventory.faces.length?<ul>{inventory.faces.map(stack=><li key={stack.face}>{stack.face} × {stack.qty}</li>)}</ul>:<p className="text-cream-muted">No charms yet.</p>}</>:<p className="mt-2 text-cream-muted">Claim your saved home to begin.</p>}<button className={`${button} mt-3`} disabled={busy} onClick={()=>void load()}>Refresh account</button></section>
        <p className="mt-2 text-sm text-cream-muted">Account inventory. The reference adventure’s equipment menu is separate.</p>
        </div>
        <div id="panel-companions" role="tabpanel" aria-labelledby="tab-companions" hidden={tab!=='companions'}>{address&&<CompanionPanel key={`companion:${address}`} wallet={address} />}</div>
        <div id="panel-exchange" role="tabpanel" aria-labelledby="tab-exchange" hidden={tab!=='exchange'}>{address&&<ExchangePanel key={`${address}:${identity.handle}`} wallet={address} handle={identity.handle} onChanged={()=>void load()} />}</div>
      </aside>
    </div></>}
    {message&&<p role="status" className="mt-4 rounded-xl border border-line bg-panel p-4">{message}</p>}
  </main>;
}
