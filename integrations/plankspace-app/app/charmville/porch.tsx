"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { savedWalletProof, walletProof } from "../auth-client";
import { connectPlankLoveWallet, getPlankLoveWalletState, subscribePlankLoveWalletState } from "../plank-love-wallet";
import { CropArt } from "./crop-art";
import { GameIcon } from "./game-icons";
import styles from "./porch.module.css";
import type { Decoration } from "../../../../lib/charmville/layout";
import { layoutDraftKey } from "../../../../lib/charmville/layout-draft";
import YardScene, { type SceneEffect } from "./scene";
import { FieldGuide } from "./field-guide";

type Plot = { plotIndex: number; crop: string | null; ripeAt: string | null; compostAfter: string | null; revision: string; tended?: boolean };
type Stack = { face: string; qty: string };
type Yard = { decorations: Decoration[]; layoutRevision: string; stamps: {postId:string;qty:string}[]; owner: boolean; claimed: boolean; serverNow: string; plots: Plot[]; inventory: null | { seeds: Stack[]; faces: Stack[]; grain: string } };
type Action = { action: string; decorations?: Decoration[]; plotIndex?: number; revision?: string; face?: string; postId?: string };
type PendingAction = {id:string;action:Action};
function recoveryKey(handle:string,wallet:string){return `charmville-recovery:${wallet.toLowerCase()}:${handle.toLowerCase()}`;}
function readRecovery(handle:string,wallet:string):PendingAction|null {
  const raw=sessionStorage.getItem(recoveryKey(handle,wallet));
  if(!raw)return null;
  const value=JSON.parse(raw) as PendingAction;
  if(!value||typeof value.id!=="string"||!/^[0-9a-f-]{36}$/i.test(value.id)||!value.action||!["claim","plant","resolve","stamp","tend","layout"].includes(value.action.action))throw new Error("The saved action could not be read. Keep this tab open and recover the session before making another change.");
  return value;
}

export default function Porch({ handle, posts, onStamps }: { handle: string; posts: { id: number; body: string }[]; onStamps: (stamps:{postId:string;qty:string}[])=>void }) {
  const [effect,setEffect] = useState<SceneEffect | null>(null);
  const [yard,setYard] = useState<Yard | null>(null);
  const [notice,setNotice] = useState("");
  const [busy,setBusy] = useState(false);
  const [expanded,setExpanded] = useState(false);
  const [bag,setBag] = useState(false);
  const [selected,setSelected] = useState("stalk");
  const [planting,setPlanting] = useState("stalk");
  const [postId,setPostId] = useState("");
  const [position,setPosition] = useState({x:24,y:100});
  const [now,setNow] = useState(0);
  const [online,setOnline] = useState(true);
  const [authenticated,setAuthenticated] = useState(false);
  const [verifiedWallet,setVerifiedWallet] = useState<string | null>(null);
  const [hasPending,setHasPending] = useState(false);
  const currentWallet = useRef<string | null>(null);
  const accountGeneration = useRef(0);
  const actionRunning = useRef(false);
  const auth = useRef("");
  const epoch = useRef(0);
  const pending = useRef<PendingAction | null>(null);
  const clock = useRef({server:0,local:0});
  const pouch = useRef<HTMLButtonElement>(null);
  const lotToggle = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const drag = useRef<{x:number;y:number;left:number;top:number} | null>(null);
  const endpoint = `/api/charmville/${encodeURIComponent(handle)}`;
  const apply = useCallback((data:Yard) => {
    setYard(data);onStamps(data.stamps??[]); clock.current={server:Date.parse(data.serverNow),local:Date.now()}; setNow(Date.parse(data.serverNow));
  },[onStamps]);
  const refresh = useCallback(async () => {
    const version=++epoch.current;
    try {
      const state=await getPlankLoveWalletState();
      const proof=state.address ? await savedWalletProof(state.address) : {};
      const token="sessionToken" in proof ? proof.sessionToken ?? "" : "";
      const response=await fetch(endpoint,{headers:token?{authorization:`Bearer ${token}`}:{},cache:"no-store"});
      const data=await response.json();
      if(version!==epoch.current)return;
      if(!response.ok)throw new Error(data.error);
      auth.current=token;setAuthenticated(!!token);currentWallet.current=state.address?.toLowerCase()??null;setVerifiedWallet(token&&data.owner?currentWallet.current:null);apply(data);
      if(token&&state.address&&!actionRunning.current){pending.current=readRecovery(handle,state.address);setHasPending(!!pending.current);if(pending.current)setNotice("An earlier action needs checking. Retry it once to recover its original receipt.");}
    } catch(error) { if(version===epoch.current)setNotice(error instanceof Error?error.message:"Porch unavailable"); }
  },[endpoint,apply,handle]);
  useEffect(()=>{
    // Initial load synchronizes this component with the external session and server ledger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const unsub=subscribePlankLoveWalletState(state=>{const address=state.address?.toLowerCase()??null;if(address===currentWallet.current)return;accountGeneration.current++;currentWallet.current=address;auth.current="";setAuthenticated(false);setVerifiedWallet(null);pending.current=null;setHasPending(false);setYard(current=>current?{...current,owner:false,inventory:null}:null);void refresh();});
    const connection=()=>{setOnline(navigator.onLine);if(navigator.onLine)void refresh();};
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    window.addEventListener("online",connection);window.addEventListener("offline",connection);document.addEventListener("visibilitychange",visible);
    return ()=>{epoch.current++;unsub();window.removeEventListener("online",connection);window.removeEventListener("offline",connection);document.removeEventListener("visibilitychange",visible);};
  },[refresh]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")setNow(clock.current.server+Date.now()-clock.current.local);},1000);
    return ()=>window.clearInterval(timer); // local clock only, never a network heartbeat
  },[]);
  const closeBag=useCallback(()=>{setBag(false);pouch.current?.focus({preventScroll:true});},[]);
  useEffect(()=>{
    if(!expanded)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!bag){setExpanded(false);lotToggle.current?.focus({preventScroll:true});}};
    window.addEventListener("keydown",escape);
    return()=>window.removeEventListener("keydown",escape);
  },[expanded,bag]);
  useEffect(()=>{
    if(!bag)return;
    dialog.current?.focus({preventScroll:true});
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")closeBag();};
    const fit=()=>setPosition(current=>({x:Math.max(0,Math.min(current.x,window.innerWidth-(dialog.current?.offsetWidth??410))),y:Math.max(0,Math.min(current.y,window.innerHeight-(dialog.current?.offsetHeight??100)))}));
    fit();window.addEventListener("resize",fit);
    window.addEventListener("keydown",escape);
    return ()=>{window.removeEventListener("keydown",escape);window.removeEventListener("resize",fit);};
  },[bag,closeBag]);

  async function act(action:Action, signIn=false):Promise<boolean> {
    if(actionRunning.current)return false;
    if(!navigator.onLine){setNotice("Reconnect to tend your porch. No action has been queued.");return false;}
    actionRunning.current=true;
    let generation=accountGeneration.current;
    setBusy(true);setNotice("");
    try {
      let token=auth.current;
      if(signIn){
        const wallet=await connectPlankLoveWallet();
        const signingGeneration=accountGeneration.current;
        const proof=await walletProof(wallet,"charmville","porch",{});
        const state=await getPlankLoveWalletState();
        if(signingGeneration!==accountGeneration.current||state.address?.toLowerCase()!==wallet.toLowerCase())throw new Error("Wallet changed during sign-in. Restore the intended wallet and try again.");
        token=proof.sessionToken;auth.current=token;currentWallet.current=wallet.toLowerCase();generation=signingGeneration;
      }
      if(generation!==accountGeneration.current)return false;
      if(!token)throw new Error("Sign in to use your porch.");
      const actor=currentWallet.current;
      if(!actor)throw new Error("Restore your wallet session before continuing.");
      pending.current ??= readRecovery(handle,actor);
      if(pending.current && JSON.stringify(pending.current.action)!==JSON.stringify(action))throw new Error("Check the pending action before making another change.");
      pending.current ??= {id:crypto.randomUUID(),action};setHasPending(true);
      // Recovery metadata only: no balances, credentials or offline action queue.
      const savedKey=recoveryKey(handle,actor);
      sessionStorage.setItem(savedKey,JSON.stringify(pending.current));
      const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({...action,requestId:pending.current.id})});
      const data=await response.json();
      if(generation!==accountGeneration.current)return false;
      if(!response.ok){
        if(response.status===401){auth.current="";setAuthenticated(false);setVerifiedWallet(null);}
        if([400,404,409,413,422].includes(response.status)){sessionStorage.removeItem(savedKey);pending.current=null;setHasPending(false);}
        if(response.status===409&&action.action==="layout")await refresh();
        throw new Error(data.error);
      }
      const effectId=pending.current?.id??crypto.randomUUID();
      sessionStorage.removeItem(savedKey);pending.current=null;setHasPending(false);apply(data);
      if(action.plotIndex!==undefined)setEffect({id:effectId,plotIndex:action.plotIndex,kind:data.action??action.action,qty:Number(data.qty??0),face:yard?.plots.find(plot=>plot.plotIndex===action.plotIndex)?.crop??action.face});
      if(action.action==="resolve"){const crop=yard?.plots.find(plot=>plot.plotIndex===action.plotIndex)?.crop;if(crop)setSelected(crop);setBag(true);setNotice(data.action==="compost"?"Seed returned. Your plot is ready for another season.":`${data.qty} faces gathered. One seed returned.`);}
      if(action.action==="stamp")setNotice("Stalk stamped onto your Grain. Your seed stays home.");
      if(action.action==="tend")setNotice("A little care left for your neighbor. You earned 1 grain.");
      await refresh();return true;
    } catch(error){if(generation===accountGeneration.current)setNotice(error instanceof Error?error.message:"Please try again");return false;}
    finally{actionRunning.current=false;setBusy(false);}
  }
  const seedCount=(face:string)=>yard?.inventory?.seeds.find(s=>s.face===face)?.qty??"0";
  return <section className={`${styles.porch} ${expanded?styles.expanded:""}`} data-market-shell aria-label="Charmville porch">
    <header className={styles.header}><h2>Charmville</h2><div>
      <button ref={lotToggle} onClick={()=>{setExpanded(v=>!v);lotToggle.current?.focus({preventScroll:true});}} aria-expanded={expanded}>{expanded?"Close the lot":"Open the lot"}</button>
      <button ref={pouch} onClick={()=>setBag(v=>!v)} aria-expanded={bag} className={styles.pouch}><GameIcon kind="satchel" /><span>Satchel</span></button>
    </div></header>
    <p className={styles.boardContext}>{yard?.owner?`Your garden · @${handle}`:authenticated?`Visiting @${handle}'s garden`:`Viewing @${handle}'s garden · Sign in to verify ownership`}</p>
    {!online&&<p role="status">Offline. Your porch is safe; reconnect to plant or harvest.</p>}
    {!yard?<p>Opening the porch… <button onClick={()=>void refresh()}>Refresh</button></p>:!yard.claimed?<div className={styles.welcome}>
      <img src="/images/plank-logo.webp" alt="Plank" width="80" height="90" />
      <p>{yard.owner?"Your six plots are waiting. Two Stalks are ready to gather.":"A porch can grow here."}</p>
      <button disabled={busy||!online} onClick={()=>yard.owner?void act({action:"claim"}):void act({action:"claim"},true)}>{yard.owner?"Claim your lot":"Connect to claim your lot"}</button>
    </div>:<>
      <YardScene key={handle} draftKey={yard.owner&&authenticated&&verifiedWallet?layoutDraftKey(verifiedWallet,handle):null} decorations={yard.decorations} layoutRevision={yard.layoutRevision} onLayout={(decorations,revision)=>act({action:"layout",decorations,revision})} plots={yard.plots} now={now} expanded={expanded} owner={yard.owner} disabled={busy||!online||!authenticated} effect={effect}
        onPlot={plot=>void act(yard.owner?{action:plot.crop?"resolve":"plant",plotIndex:plot.plotIndex,revision:plot.revision,...(!plot.crop?{face:planting}:{})}:{action:"tend",plotIndex:plot.plotIndex,revision:plot.revision})}/>
      {yard.owner?<fieldset className={styles.seeds}><legend>Plant your next appointment</legend>{["stalk","splinter"].map(face=><label key={face}><input type="radio" name={`seed-${handle}`} checked={planting===face} onChange={()=>setPlanting(face)}/>{face==="stalk"?"Stalk · 4h · seed only":"Splinter · 16h · seed + 2 grain"}<small>{seedCount(face)} seeds</small></label>)}</fieldset>:<p>Leave a little care on a growing plot. Only the owner can harvest.</p>}
      {!authenticated&&<button disabled={busy} onClick={async()=>{setBusy(true);try{const w=await connectPlankLoveWallet();await walletProof(w,"charmville","porch",{});await refresh();}catch(e){setNotice(e instanceof Error?e.message:"Sign-in failed");}finally{setBusy(false);}}}>Sign in to tend</button>}
    </>}
    <FieldGuide owner={yard?.owner??false} claimed={yard?.claimed??false} ready={yard?.plots.filter(plot=>plot.crop&&plot.ripeAt&&plot.compostAfter&&Date.parse(plot.ripeAt)<=now&&Date.parse(plot.compostAfter)>now).length??0} faces={yard?.inventory?.faces.some(stack=>BigInt(stack.qty)>0n)??false} seeds={yard?.inventory?.seeds.some(stack=>BigInt(stack.qty)>0n)??false} onBag={()=>setBag(true)}/>
    <p role="status" className={styles.notice}>{notice}</p>
    {hasPending&&!busy&&<button onClick={()=>void act(pending.current!.action)}>Check / retry pending action</button>}
    {bag&&createPortal(<div className={styles.windowLayer} data-market-shell><div className={styles.window} ref={dialog} tabIndex={-1} role="dialog" aria-label="Satchel" style={{left:position.x,top:position.y}}>
      <header className={styles.windowHeader} tabIndex={0} aria-label="Move satchel: use arrow keys, or Home to reset" onKeyDown={e=>{
        if(e.target!==e.currentTarget)return;
        if(e.key==="Home"){e.preventDefault();setPosition({x:24,y:100});return;}
        const movement:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
        const delta=movement[e.key];if(!delta)return;e.preventDefault();const step=e.shiftKey?40:10;
        setPosition(current=>({x:Math.max(0,Math.min(window.innerWidth-(dialog.current?.offsetWidth??410),current.x+delta[0]*step)),y:Math.max(0,Math.min(window.innerHeight-(dialog.current?.offsetHeight??100),current.y+delta[1]*step))}));
      }} onPointerDown={e=>{if((e.target as HTMLElement).closest("button"))return;drag.current={x:e.clientX,y:e.clientY,left:position.x,top:position.y};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(!drag.current)return;setPosition({x:Math.max(0,Math.min(window.innerWidth-(dialog.current?.offsetWidth??410),drag.current.left+e.clientX-drag.current.x)),y:Math.max(0,Math.min(window.innerHeight-Math.min(dialog.current?.offsetHeight??100,window.innerHeight),drag.current.top+e.clientY-drag.current.y))});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><h2>Satchel</h2><button onClick={closeBag} aria-label="Close satchel">×</button></header>
      <div className={styles.inventory}>{yard?.inventory?<><div className={styles.stacks}>{["stalk","splinter"].map(face=><button key={face} aria-pressed={selected===face} onClick={()=>setSelected(face)}><CropArt face={face}/><span>{face}</span><b>{yard.inventory!.faces.find(s=>s.face===face)?.qty??"0"}</b></button>)}</div>
        <div className={styles.selected}><CropArt face={selected}/><strong>{selected==="stalk"?"Stalk":"Splinter"}</strong><span>{selected==="stalk"?"Your everyday stamp":"Your overnight timber"}</span><small>{yard.inventory.faces.find(stack=>stack.face===selected)?.qty??"0"} in your bag</small></div>
        <div className={styles.seedStacks}>{yard.inventory.seeds.map(seed=><span key={seed.face}><CropArt face={seed.face} seed/>{seed.face} seeds <b>{seed.qty}</b></span>)}</div>
        <label className={styles.send}>Send a Stalk stamp to your Grain<select value={postId} onChange={e=>setPostId(e.target.value)}><option value="">Choose a Grain</option>{posts.map(p=><option key={p.id} value={p.id}>{p.body.slice(0,60)}</option>)}</select></label>
        <button disabled={busy||!postId||!online||!authenticated||selected!=="stalk"||!yard.inventory.faces.some(stack=>stack.face==="stalk"&&BigInt(stack.qty)>0n)} onClick={()=>void act({action:"stamp",postId})}>SEND · 1 Stalk</button>
        {selected!=="stalk"&&<p className={styles.bagHelp}>Splinter stays in your bag. Choose Stalk to stamp a pine.</p>}
        <button className={styles.returnToGarden} disabled={busy} onClick={()=>{setPlanting(selected);closeBag();}}>Back to garden · plant {selected}</button>
        <footer>{yard.inventory.grain} grain <span>Seeds return. Faces are yours to spend.</span></footer></>:<p>Sign in on your own board to open your inventory.</p>}</div>
      <button className={styles.reset} onClick={()=>setPosition({x:24,y:100})}>Reset window position</button>
    </div></div>,document.body)}
  </section>;
}
