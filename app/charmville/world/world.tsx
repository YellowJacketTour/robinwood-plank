"use client";
import {runtimeDestination} from './runtime-destination';
import {bootRuntimeSession,renewRuntimeSession} from './runtime-boot';
import './world-shell.css';
import {createCaptureStream} from "./capture-stream";

import Link from "next/link";
import Image from "next/image";
import SocialPanel from "./social-panel";
import SpectatorSettings from './spectator-settings';
import RegionMap from "./region-map";
import ControlGuide from "./control-guide";
import FirstSteps from "./first-steps";
import {useTutorialBridge} from "./tutorial-bridge";
import HomePermissions from "../start/home-permissions";
import FriendsTravelPanel from "./friends-panel";
import {useMenuGamepad} from "./use-menu-gamepad";
import {attachLocalPlaytestWallet} from "@/lib/charmville/local-playtest-client";
import InventoryPanel from "./inventory-panel";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import { createGameAccountClient, type GameIdentity } from "@/lib/charmville/account-client";
import type { YardInventory } from "@/lib/charmville/inventory";
import ExchangePanel from "./exchange-panel";
import CompanionPanel from "./companion-panel";
import EncounterPanel from "./encounter-panel";
import {nativeEncounterProjection} from "@/lib/charmville/native-encounter-projection";
import {useNativeResources} from "./native-resources";
import {useNativeMovement} from "./native-movement";
import {useNativeContactObserver} from "./native-contact-observer";
import {requestWorldEntry} from "@/lib/charmville/world-entry-client";

type Presence = { profileId:string; regionId:string; ownerHandle:string|null; revision:string; expiresAt:string;
  active:boolean; peers:Array<{profileId:string;handle:string}>; reason:string|null };
type Session = { identity:GameIdentity; token:string };
const tabs=[['play','Play'],['companions','Party'],['inventory','Bag'],['exchange','Exchange'],['friends','Friends'],['social','Social'],['journal','Journal'],['map','Map'],['settings','Options']] as const;
type WorldTab=typeof tabs[number][0];
const menuArt:Record<WorldTab,string>={play:'bicycle',companions:'poke_ball',inventory:'berry_pouch',exchange:'coin_case',friends:'harbor_mail',social:'heart',journal:'retro_mail',map:'town_map',settings:'devon_scope'};
function MenuArt({panel}:{panel:WorldTab}){return <Image unoptimized alt="" width={32} height={32} src={panel==='social'?'/charmville/items/burning-heart.svg':`/charmville/reference-items/pokeemerald/graphics/items/icons/${menuArt[panel]}.png`}/>;}
const button = "min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50";

const subscribeOrigin=()=>()=>{};
const browserOrigin=()=>window.location.origin;
export default function World({localRuntime,runtimePrefix}:{localRuntime:boolean;runtimePrefix?:string|null}) {
  const pageOrigin=useSyncExternalStore(subscribeOrigin,browserOrigin,()=>"");
  const destination=runtimeDestination(localRuntime,runtimePrefix,pageOrigin);
  const runtimeOrigin=destination?.origin??"",runtimeUrl=destination?.url??"",runtimeNeedsSession=destination?.requiresSession??false;
  const runtimeBoot=useRef<AbortController|null>(null);
  const [runtimeOpening,setRuntimeOpening]=useState(false);
  const [runtimeExpiry,setRuntimeExpiry]=useState<string|null>(null);
  const [runtimeIssue,setRuntimeIssue]=useState("");
  const [identity,setIdentity]=useState<GameIdentity|null>(null);
  const [address,setAddress]=useState("");
  const [presence,setPresence]=useState<Presence|null>(null);
  const [arrivalRequest,setArrivalRequest]=useState(0);
  const [inventory,setInventory]=useState<YardInventory|null>(null);
  const [journeyRevision,setJourneyRevision]=useState(0);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [camera,setCamera]=useState(false);
  const [fullscreen,setFullscreen]=useState(false);
  const [tab,setTab]=useState<WorldTab>('play');
  const [menuOpen,setMenuOpen]=useState(false);
  const [nativePanels,setNativePanels]=useState<string[]>([]);
  const selectTab=useCallback((next:WorldTab)=>{setMenuOpen(false);setTab(next);},[]);
  const frame=useRef<HTMLIFrameElement|null>(null);
  const menuRoot=useRef<HTMLElement|null>(null);
  const returnToPlay=useCallback(()=>{setMenuOpen(false);setTab('play');requestAnimationFrame(()=>{if(presence?.active)frame.current?.focus();else document.getElementById('arrival-primary')?.focus();});},[presence?.active]);
  useMenuGamepad(menuRoot,Boolean(identity),returnToPlay,tab);
  // Keep the live world mounted, but give the account pages exclusive input.
  // Moving focus also makes the native controller release held inputs on blur.
  useLayoutEffect(()=>{
    if(tab==='play'&&!menuOpen&&presence?.active)return;
    const focused=document.activeElement;
    if(focused===frame.current||focused===document.body||focused instanceof Element&&focused.closest('[inert]')){
      document.getElementById(menuOpen?'world-menu-first':tab==='play'?'arrival-primary':`tab-${tab}`)?.focus({preventScroll:true});
    }
    const back=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||menuRoot.current?.querySelector('dialog[open]'))return;
      event.preventDefault();
      returnToPlay();
    };
    window.addEventListener('keydown',back);
    return()=>window.removeEventListener('keydown',back);
  },[tab,menuOpen,returnToPlay,presence?.active]);
  useEffect(()=>{
    if(!menuOpen)return;
    document.getElementById('world-menu-first')?.focus({preventScroll:true});
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=='Tab')return;
      const controls=Array.from(document.querySelectorAll<HTMLButtonElement>('.world-start-menu button')).filter(button=>!button.disabled);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    window.addEventListener('keydown',trap);return()=>window.removeEventListener('keydown',trap);
  },[menuOpen]);
  useNativeContactObserver(frame,runtimeOrigin);
  const frameReady=useRef(false);
  const encounterSnapshot=useRef<unknown>(null);
  const socketEncounterAt=useRef(0);
  const captureAvailable=useRef(false);
  const updateCaptureAvailability=useCallback((available:boolean)=>{captureAvailable.current=available;if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:capture-availability',available},runtimeOrigin);},[runtimeOrigin]);
  const [captureStream]=useState(()=>createCaptureStream());
  const updateEncounter=useCallback((snapshot:unknown|null)=>{
    if(Date.now()-socketEncounterAt.current<1000)return;
    encounterSnapshot.current=snapshot;
    if(frameReady.current)frame.current?.contentWindow?.postMessage(nativeEncounterProjection(snapshot),runtimeOrigin);
    for(const event of captureStream.snapshot(snapshot)){if(frameReady.current)frame.current?.contentWindow?.postMessage(event,runtimeOrigin);}
  },[captureStream,runtimeOrigin]);
  const updateSocketEncounter=useCallback((snapshot:unknown|null)=>{
    socketEncounterAt.current=0;
    updateEncounter(snapshot);
    if(snapshot!==null)socketEncounterAt.current=Date.now();
  },[updateEncounter]);
  const showCapture=useCallback((receipt:unknown)=>{
    const event=captureStream.receipt(receipt);
    if(event&&frameReady.current)frame.current?.contentWindow?.postMessage(event,runtimeOrigin);
  },[captureStream,runtimeOrigin]);
  const followerSpecies=useRef(0);
  const partySpecies=useRef<number[]>([]);
  const partyCreatureIds=useRef<string[]>([]);
  const followerFormation=useRef<'close'|'relaxed'>('close');
  const updateFormation=useCallback((formation:'close'|'relaxed')=>{
    followerFormation.current=formation;
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:follower-formation',formation},runtimeOrigin);
  },[runtimeOrigin]);
  const updateFollowers=useCallback((speciesIds:number[],creatureIds:string[]=[])=>{
    const members=speciesIds.map((speciesId,index)=>({speciesId,id:creatureIds[index]??''})).filter(member=>[277,280,283,25,133,286].includes(member.speciesId)).slice(0,6);
    partySpecies.current=members.map(member=>member.speciesId);
    partyCreatureIds.current=members.map(member=>member.id);
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:party-followers',speciesIds:partySpecies.current,creatureIds:partyCreatureIds.current},runtimeOrigin);
  },[runtimeOrigin]);
  const updateFollower=useCallback((speciesId:number)=>{
    followerSpecies.current=[277,280,283,25,133,286].includes(speciesId)?speciesId:0;
    if(frameReady.current)frame.current?.contentWindow?.postMessage({type:'charmville:follower',speciesId:followerSpecies.current},runtimeOrigin);
  },[runtimeOrigin]);
  const pendingPanel=useRef<'charmdex'|'voice'|'gear'|'map'|'settings'|null>(null);
  const session=useRef<Session|null>(null);
  const [sessionToken,setSessionToken]=useState<string|null>(null);
  const tutorialStatus=useTutorialBridge(frame,sessionToken,runtimeOrigin);
  const wallet=useRef<string|null>(null);
  const generation=useRef(0);
  const inFlight=useRef<AbortController|null>(null);
  const location=useRef<Presence|null>(null);
  const [accountClient]=useState(()=>createGameAccountClient());
  const mounted=useRef(true);
  const signingIn=useRef(false);
  const {status:movementStatus,map:regionMap}=useNativeMovement(frame,session,identity?.profileId,presence?.active?`${presence.regionId}:${arrivalRequest}`:undefined,updateSocketEncounter,runtimeOrigin);

  const openAdventure=useCallback(async(forceSession=false)=>{
    if(!runtimeUrl||runtimeBoot.current)return false;
    if(camera&&!forceSession)return true;
    if(!runtimeNeedsSession){setCamera(true);return true;}
    const account=session.current;
    if(!account){setRuntimeIssue('Sign in before opening the adventure.');return false;}
    const controller=new AbortController(),version=generation.current;
    runtimeBoot.current=controller;setRuntimeOpening(true);setRuntimeIssue('');
    try{
      const lease=await bootRuntimeSession({token:account.token,signal:controller.signal,isCurrent:()=>mounted.current&&version===generation.current&&session.current?.token===account.token});
      setRuntimeExpiry(lease.expiresAt);setCamera(true);return true;
    }catch(error){
      if(!controller.signal.aborted&&mounted.current&&version===generation.current)setRuntimeIssue(error instanceof Error?error.message:'The adventure could not open.');
      return false;
    }finally{if(runtimeBoot.current===controller){runtimeBoot.current=null;if(mounted.current)setRuntimeOpening(false);}}
  },[runtimeUrl,runtimeNeedsSession,camera]);

  useEffect(()=>{
    if(!camera||!runtimeNeedsSession||!runtimeExpiry||!sessionToken)return;
    const controller=new AbortController(),version=generation.current;
    const renew=async()=>{
      try{
        const lease=await renewRuntimeSession({token:sessionToken,signal:controller.signal,isCurrent:()=>mounted.current&&generation.current===version&&session.current?.token===sessionToken});
        setRuntimeExpiry(lease.expiresAt);setRuntimeIssue('');
      }catch(error){if(!controller.signal.aborted&&mounted.current&&generation.current===version)setRuntimeIssue(error instanceof Error?error.message:'Game access could not be renewed. Reconnect when ready.');}
    };
    // One bounded renewal attempt, then explicit player recovery on failure.
    const timer=setTimeout(()=>void renew(),Math.max(1000,Date.parse(runtimeExpiry)-Date.now()-60_000));
    return()=>{clearTimeout(timer);controller.abort();};
  },[camera,runtimeNeedsSession,runtimeExpiry,sessionToken]);

  const clear=useCallback(()=>{
    runtimeBoot.current?.abort();runtimeBoot.current=null;setRuntimeOpening(false);setRuntimeExpiry(null);setRuntimeIssue("");setCamera(false);
    socketEncounterAt.current=0;
    ++generation.current; inFlight.current?.abort(); inFlight.current=null;
    accountClient.disconnect(); session.current=null;setSessionToken(null); location.current=null;updateCaptureAvailability(false);
    frame.current?.contentWindow?.postMessage({type:'charmville:capture-event',active:false},runtimeOrigin);
    updateEncounter(null);
    updateFollower(0);
    updateFollowers([]);
    pendingPanel.current=null;
    frameReady.current=false;
  },[accountClient,updateFollower,updateFollowers,updateEncounter,updateCaptureAvailability,runtimeOrigin]);

  const load=useCallback(async(destination?:{destination:"home"|"public";handle?:string},background=false)=>{
    const account=session.current;
    if(!account)return;
    inFlight.current?.abort();
    const controller=new AbortController();inFlight.current=controller;
    const version=generation.current;
    if(!background){setBusy(true);setMessage("");}
    const request=async(path:string,body?:object)=>{
      const response=await fetch(path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${account.token}`,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,
        cache:"no-store",credentials:"same-origin",mode:"same-origin",redirect:"error",signal:controller.signal});
      let data;
      try{data=await response.json();}catch(error){
        // Preserve denial status even when a proxy supplies an HTML error body.
        // A malformed success can be retried with the same admission revision.
        if(!response.ok)throw Object.assign(new Error('Your world could not be refreshed.'),{status:response.status});
        throw error;
      }
      if(!response.ok)throw Object.assign(new Error(data.error??"Your world could not be refreshed."),{status:response.status});
      return data;
    };
    try {
      const next=(destination?await requestWorldEntry({
        entry:{...destination,revision:location.current?.revision??"0"},
        request:entry=>request("/api/charmville/world/presence",entry),
        signal:controller.signal,isCurrent:()=>version===generation.current,
      }):await request("/api/charmville/world/presence")) as Presence;
      if(controller.signal.aborted||version!==generation.current)return;
      // Commit admission independently: an inventory read failure must not hide a successful move.
      location.current=next;setPresence(next);
      // Explicit travel also recovers the native camera when returning to the
      // same admitted region. Background inventory/presence refreshes must not
      // reset movement or repeatedly teleport the player.
      if(destination&&next.active&&!background)setArrivalRequest(value=>value+1);
      const yard=await request(`/api/charmville/${encodeURIComponent(account.identity.handle)}`) as {inventory:YardInventory|null};
      if(controller.signal.aborted||version!==generation.current)return;
      setInventory(yard.inventory);
      if(next.reason==="permission-revoked")setMessage("Your home invitation changed. Return to the public meadow.");
      return true;
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
    wallet.current=test.wallet;session.current={identity:verified,token:test.token};setSessionToken(test.token);
    setAddress(test.wallet);setIdentity(verified);setPresence(null);setInventory(null);setCamera(!runtimeNeedsSession);setTab('companions');
    await load();
  },[localRuntime,accountClient,clear,load,runtimeNeedsSession]);
  const resourceChanged=useCallback(()=>{
    // Refresh accomplishments after the authoritative receipt, even if the
    // following inventory refresh fails or the action did not change a balance.
    setJourneyRevision(value=>value+1);
    void load();
  },[load]);
  const resourceStatus=useNativeResources(frame,session,identity?.profileId,presence?.active?presence.regionId:undefined,resourceChanged,runtimeOrigin);

  const restore=useCallback(async(token:string,version:number)=>{
    if(version!==generation.current)return;
    const account=await accountClient.connect(token);
    if(version!==generation.current)return;
    session.current={identity:account,token};setSessionToken(token);setIdentity(account);
    setAddress(wallet.current??"");
    if(!runtimeNeedsSession&&runtimeUrl)setCamera(true);
    await load();
  },[accountClient,load,runtimeNeedsSession,runtimeUrl]);

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
      if(!runtimeOrigin||event.origin!==runtimeOrigin||event.source!==frame.current?.contentWindow)return;
      if(event.data?.type==='charmville:menu-capabilities'){setNativePanels(Array.isArray(event.data.panels)?event.data.panels.filter((panel:unknown)=>['gear','map','settings'].includes(String(panel))):[]);return;}
      if(event.data?.type==='charmville:capture-request'){if(captureAvailable.current)window.dispatchEvent(new Event('charmville:capture-request'));return;}
      if(event.data?.type==='charmville:follower-ready'){updateCaptureAvailability(captureAvailable.current);updateFollower(followerSpecies.current);updateFollowers(partySpecies.current,partyCreatureIds.current);updateFormation(followerFormation.current);updateEncounter(encounterSnapshot.current);return;}
      if(event.data?.type!=='charmville:account-menu')return;
      if(event.data.panel==='menu'){setTab('play');setMenuOpen(true);return;}
      const panel=event.data.panel;
      if(!tabs.some(([id])=>id===panel)||panel==='play')return;
      if(document.fullscreenElement===frame.current)void document.exitFullscreen().catch(()=>{});
      setMenuOpen(false);setTab(panel);
      requestAnimationFrame(()=>{const selected=document.getElementById(`tab-${panel}`);selected?.focus();selected?.scrollIntoView({block:'start'});});
    };
    window.addEventListener('message',returnToMenus);
    return()=>window.removeEventListener('message',returnToMenus);
  },[updateFollower,updateFollowers,updateFormation,updateEncounter,updateCaptureAvailability,runtimeOrigin]);

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
      if(current?.active)void load(current.ownerHandle?{destination:"home",handle:current.ownerHandle}:{destination:"public"},true);
      else void load(undefined,true);
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

  function toggleFullscreen(){
    if(typeof document.documentElement.requestFullscreen!=="function"){setMessage("Fullscreen is unavailable in this browser.");return;}
    const action=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
    void action.catch(()=>setMessage("Fullscreen is unavailable in this browser."));
  }

  function sendPanel(){
    if(!pendingPanel.current||!frameReady.current||!frame.current?.contentWindow)return;
    frame.current.contentWindow.postMessage({type:'charmville:open-panel',panel:pendingPanel.current},runtimeOrigin);
    pendingPanel.current=null;
  }
  function openPanel(panel:'charmdex'|'voice'|'gear'|'map'|'settings'){
    if(!runtimeUrl){setMessage("The adventure runtime is not ready on this deployment.");return;}
    pendingPanel.current=panel;setMenuOpen(false);setTab('play');
    if(camera)sendPanel();else {frameReady.current=false;void openAdventure();}
  }

  return <main ref={menuRoot} data-market-shell data-playing={identity?'true':'false'} data-world-tab={tab} className="charm-world min-h-screen bg-wood-950 p-3 text-cream sm:p-5">
    <header className="world-topbar">
      <div className="world-brand"><span aria-hidden="true" className="world-brand-heart">♥</span><div><h1>CHARMVILLE</h1><p>{identity?(presence?.active?(presence.ownerHandle?'Homestead':'Public meadow'):'Choose your arrival'):'Your adventure awaits'}</p></div></div>
      <nav aria-label="World shortcuts"><button className={button} aria-label="Open game menu" aria-expanded={menuOpen||tab!=='play'} onClick={()=>{setTab('play');setMenuOpen(value=>!value);}}>Menu <kbd>Enter</kbd></button><button className={button} aria-label="World map" onClick={()=>selectTab('map')}><MenuArt panel="map"/></button><button className={button} aria-label="Toggle fullscreen" aria-pressed={fullscreen} onClick={toggleFullscreen}>⛶</button></nav>
    </header>
    {!identity?<section className="rounded-xl border border-line bg-panel p-5"><h2 className="font-display text-xl">Bring your account into the world</h2><p className="my-3 text-cream-muted">Sign in with your approved PlankSpace profile. Your saved inventory stays with your account.</p><button className={button} disabled={busy} onClick={enter}>{busy?"Signing in…":"Connect and sign in"}</button><Link className="ml-4 text-gold-300" href="/charmville/start">Create or finish your profile</Link></section>:
    <>
    <div className={`world-stage grid gap-4 ${tab!=='play'?'xl:grid-cols-[minmax(320px,1fr)_minmax(0,1.2fr)]':''}`}>
      <section id="panel-play" inert={menuOpen||tab!=='play'||!presence?.active} aria-hidden={menuOpen||tab!=='play'||!presence?.active} role="tabpanel" aria-labelledby="tab-play" className={`world-adventure min-w-0 self-start rounded-xl border border-line bg-panel p-3 ${tab!=='play'&&tab!=='social'?'hidden xl:block':''}`} aria-label="Native adventure camera">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-display text-xl text-gold-300">Adventure</h2><span className="text-xs text-cream-muted">Enter · Game menus</span></div>
        <p role="status" className="mb-2 text-sm text-cream-muted">{resourceStatus||movementStatus}</p>
        {runtimeIssue&&<div role="alert" className="mb-3 rounded-lg border border-line p-3"><p>{runtimeIssue}</p>{runtimeNeedsSession&&camera&&<button className={button} disabled={runtimeOpening} onClick={()=>void openAdventure(true)}>{runtimeOpening?'Reconnecting...':'Reconnect game access'}</button>}</div>}

        {camera&&runtimeUrl?<iframe ref={frame} onLoad={()=>{frameReady.current=true;updateCaptureAvailability(captureAvailable.current);frame.current?.contentWindow?.postMessage({type:'charmville:account-peers',active:true,peers:[]},runtimeOrigin);frame.current?.contentWindow?.postMessage({type:'charmville:host-ready'},runtimeOrigin);updateFollower(followerSpecies.current);updateFollowers(partySpecies.current,partyCreatureIds.current);updateFormation(followerFormation.current);updateEncounter(encounterSnapshot.current);sendPanel();}} title="Charmville native reference adventure" src={runtimeUrl} sandbox="allow-scripts allow-same-origin allow-downloads" allow="cross-origin-isolated; fullscreen; gamepad; keyboard-map; microphone" allowFullScreen referrerPolicy="no-referrer" className="h-[72vh] min-h-96 w-full rounded-lg border border-line" />:
          <div className="flex min-h-96 items-center justify-center rounded-lg border border-line bg-panel-soft p-6">{runtimeUrl?<button className={button} disabled={runtimeOpening} onClick={()=>void openAdventure()}>{runtimeOpening?'Opening adventure...':'Load adventure'}</button>:<p className="text-cream-muted">Native hosting is being connected. Account locations and inventory are available independently.</p>}</div>}
        {address&&<EncounterPanel key={`encounter:${address}`} wallet={address} active={Boolean(presence?.active)} onSnapshot={updateEncounter} onCaptureReceipt={showCapture} onCaptureAvailability={updateCaptureAvailability} onParty={()=>setTab('companions')}/>}
      </section>
      {tab==='play'&&!presence?.active&&<section className="world-arrival" aria-label="Choose your arrival">
        <div><p className="text-xs font-bold tracking-wide text-gold-300">CHARMVILLE · YOUR JOURNEY</p>
        <h2 className="my-3 font-display text-2xl">{inventory?'Welcome back, '+identity.handle:'A home. A companion. A world to explore.'}</h2>
        <p className="mb-5 max-w-xl text-cream-muted">{inventory?'Enter your homestead to tend your crops and prepare your party, or meet other players in the meadow.':'Begin in Party to claim your home and choose your first companion. Your supplies and companions stay with your account.'}</p>
        <div className="flex flex-wrap gap-3"><button id="arrival-primary" className={`${button} bg-gold-500 text-wood-950`} disabled={busy} onClick={()=>{if(inventory)void load({destination:'home',handle:identity.handle});else setTab('companions');}}>{busy?'Checking your arrival…':inventory?'Enter my home':'Begin my journey'}</button>
        <button className={button} disabled={busy} onClick={()=>void load({destination:'public'})}>Visit the public meadow</button>
        <button className={button} disabled={busy} onClick={()=>setTab('friends')}>Visit a friend</button></div>
        <p className="mt-5 text-sm text-cream-muted">{presence?.reason==='permission-revoked'?'Your invitation has changed. Choose an available destination.':'Gameplay connects after your destination accepts your account.'}</p></div>
      </section>}
      {menuOpen&&<section className="world-start-menu" role="dialog" aria-modal="true" aria-label="Game menu">
        <header><span>CHARMDEX</span><button onClick={returnToPlay} aria-label="Close game menu">×</button></header>
        <p className="world-trainer">@{identity.handle}</p>
        <nav aria-label="Adventure tools" onKeyDown={event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;event.preventDefault();buttons[next]?.focus();}}>{tabs.filter(([id])=>id!=='play').map(([id,label],index)=><button id={index===0?'world-menu-first':undefined} key={id} onClick={()=>selectTab(id)}><MenuArt panel={id}/><span>{label}</span><span aria-hidden="true">›</span></button>)}{nativePanels.includes('gear')&&<button onClick={()=>openPanel('gear')}><Image unoptimized alt="" width={32} height={32} src="/charmville/reference-items/pokeemerald/graphics/items/icons/macho_brace.png"/><span>Gear</span><span aria-hidden="true">›</span></button>}</nav>
        <button className="world-continue" onClick={returnToPlay}>Return to adventure <kbd>B</kbd></button>
      </section>}
      <aside data-social={tab==='social'} className={tab==='play'?'hidden':'world-menu'} aria-label="Account world controls">
        <header className="world-menu-heading"><div><MenuArt panel={tab}/><h2>{tabs.find(([id])=>id===tab)?.[1]}</h2></div><button className={button} onClick={returnToPlay}>Close <kbd>Esc</kbd></button></header>
        <nav className="world-pocket-rail" role="tablist" aria-label="Game and account">{tabs.map(([id,label],index)=><button key={id} id={`tab-${id}`} role="tab" aria-selected={tab===id} aria-controls={`panel-${id}`} tabIndex={tab===id?0:-1} title={label} onClick={()=>selectTab(id)} onKeyDown={event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else return;event.preventDefault();selectTab(tabs[next][0]);document.getElementById(`tab-${tabs[next][0]}`)?.focus();}}><MenuArt panel={id}/><span>{label}</span></button>)}</nav>
        <div id="panel-journal" role="tabpanel" aria-labelledby="tab-journal" hidden={tab!=='journal'}>    {sessionToken&&<div className="world-journal"><FirstSteps onPlay={returnToPlay} inventory={inventory} onOpenFreshSatchel={async()=>{if(!await load())throw Error('Your Satchel could not be refreshed. Try again.');setTab('inventory');}} onSatchel={()=>setTab('inventory')} onExchange={()=>setTab('exchange')} key={identity.profileId} token={sessionToken} refreshKey={`${tab}:${presence?.revision??'0'}:${inventory!==null}:${journeyRevision}`} handle={identity.handle} profileId={identity.profileId} busy={busy} location={presence} onSetup={()=>setTab('companions')} onHome={()=>void load({destination:'home',handle:identity.handle})} onPublic={()=>void load({destination:'public'})} onFriends={()=>setTab('friends')}/></div>}</div>
        <div id="panel-map" role="tabpanel" aria-labelledby="tab-map" hidden={tab!=='map'}>{nativePanels.includes('map')&&<button className={button} onClick={()=>openPanel('map')}>Open live world camera</button>}<RegionMap state={regionMap}/></div>
        <div id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={tab!=='settings'} className="world-options"><ControlGuide/>{nativePanels.includes('settings')&&<button className={button} onClick={()=>openPanel('settings')}>Adventure controls & sound</button>}{sessionToken&&<SpectatorSettings key={identity.profileId} handle={identity.handle} token={sessionToken}/>}<button className={button} onClick={toggleFullscreen}>Toggle fullscreen</button><button className={button} onClick={()=>openPanel('voice')}>Voice note</button><button className={button} onClick={()=>openPanel('charmdex')}>Discover charms</button><Link className={button} href="/plankspace">Open PlankSpace</Link><p>{resourceStatus||movementStatus}</p><p>{tutorialStatus}</p></div>
        <div id="panel-social" role="tabpanel" aria-labelledby="tab-social" hidden={tab!=='social'}>{sessionToken&&<SocialPanel key={identity.profileId} token={sessionToken} active={tab==='social'} onPinned={()=>void load()}/>}</div>
        <div id="panel-friends" role="tabpanel" aria-labelledby="tab-friends" hidden={tab!=='friends'} className="space-y-4">
        <FriendsTravelPanel key={identity.profileId} handle={identity.handle} profileId={identity.profileId} presence={presence} busy={busy} onTravel={destination=>void load(destination)} onPlay={returnToPlay}/>
        {address&&tab==='friends'&&<HomePermissions key={`${address}:${identity.handle}`} handle={identity.handle} wallet={address} />}
        <button className={button} disabled={busy} onClick={()=>void load()}>Refresh account</button>
        </div>
        <div id="panel-inventory" role="tabpanel" aria-labelledby="tab-inventory" hidden={tab!=='inventory'}>
        <InventoryPanel inventory={inventory} busy={busy} onSetup={()=>setTab('companions')} onRefresh={()=>void load()}/>
        <p className="mt-2 text-sm text-cream-muted">Seeds grow into charms. Equipment is available in the adventure’s native item menu.</p>
        </div>
        <div id="panel-companions" role="tabpanel" aria-labelledby="tab-companions" hidden={tab!=='companions'}>{address&&<CompanionPanel key={`companion:${address}`} wallet={address} handle={identity.handle} onHomeReady={load} onEnterHome={()=>{setTab("play");void load({destination:"home",handle:identity.handle});}} onFollower={updateFollower} onFollowers={updateFollowers} onFormation={updateFormation} onTestProfile={openTestProfile} onPlay={()=>{setTab('play');void openAdventure().then(opened=>{if(opened)requestAnimationFrame(()=>frame.current?.focus());});}} />}</div>
        <div id="panel-exchange" role="tabpanel" aria-labelledby="tab-exchange" hidden={tab!=='exchange'}>{address&&<ExchangePanel key={`${address}:${identity.handle}`} wallet={address} handle={identity.handle} onChanged={()=>void load()} />}</div>
      </aside>
    </div></>}
    {message&&<p role="status" className="mt-4 rounded-xl border border-line bg-panel p-4">{message}</p>}
  </main>;
}
