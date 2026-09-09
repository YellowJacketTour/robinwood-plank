"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { savedWalletProof, walletProof } from "../auth-client";
import { connectPlankLoveWallet, getPlankLoveWalletState, subscribePlankLoveWalletState } from "../plank-love-wallet";
import { CropArt, PouchArt } from "./crop-art";
import styles from "./porch.module.css";
import type { Decoration } from "../../../../lib/charmville/layout";
import YardScene, { type SceneEffect } from "./scene";

type Plot = { plotIndex: number; crop: string | null; ripeAt: string | null; compostAfter: string | null; revision: string; tended?: boolean };
type Stack = { face: string; qty: string };
type Yard = { decorations: Decoration[]; layoutRevision: string; stamps: {postId:string;qty:string}[]; owner: boolean; claimed: boolean; serverNow: string; plots: Plot[]; inventory: null | { seeds: Stack[]; faces: Stack[]; grain: string } };
type Action = { action: string; decorations?: Decoration[]; plotIndex?: number; revision?: string; face?: string; postId?: string };

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
  const [hasPending,setHasPending] = useState(false);
  const currentWallet = useRef<string | null>(null);
  const accountGeneration = useRef(0);
  const actionRunning = useRef(false);
  const auth = useRef("");
  const epoch = useRef(0);
  const pending = useRef<{id:string;action:Action} | null>(null);
  const clock = useRef({server:0,local:0});
  const pouch = useRef<HTMLButtonElement>(null);
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
      auth.current=token;setAuthenticated(!!token);currentWallet.current=state.address?.toLowerCase()??null;apply(data);
    } catch(error) { if(version===epoch.current)setNotice(error instanceof Error?error.message:"Porch unavailable"); }
  },[endpoint,apply]);
  useEffect(()=>{
    // Initial load synchronizes this component with the external session and server ledger.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const unsub=subscribePlankLoveWalletState(state=>{const address=state.address?.toLowerCase()??null;if(address===currentWallet.current)return;accountGeneration.current++;currentWallet.current=address;auth.current="";setAuthenticated(false);pending.current=null;setHasPending(false);setYard(null);void refresh();});
    const connection=()=>{setOnline(navigator.onLine);if(navigator.onLine)void refresh();};
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    window.addEventListener("online",connection);window.addEventListener("offline",connection);document.addEventListener("visibilitychange",visible);
    return ()=>{epoch.current++;unsub();window.removeEventListener("online",connection);window.removeEventListener("offline",connection);document.removeEventListener("visibilitychange",visible);};
  },[refresh]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")setNow(clock.current.server+Date.now()-clock.current.local);},1000);
    return ()=>window.clearInterval(timer); // local clock only, never a network heartbeat
  },[]);
  const closeBag=useCallback(()=>{setBag(false);pouch.current?.focus();},[]);
  useEffect(()=>{
    if(!bag)return;
    dialog.current?.focus();
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")closeBag();};
    window.addEventListener("keydown",escape);
    return ()=>window.removeEventListener("keydown",escape);
  },[bag,closeBag]);

  async function act(action:Action, signIn=false):Promise<boolean> {
    if(actionRunning.current)return false;
    if(!navigator.onLine){setNotice("Reconnect to tend your porch. No action has been queued.");return false;}
    actionRunning.current=true;
    let generation=accountGeneration.current;
    setBusy(true);setNotice("");
    try {
      let token=auth.current;
      if(signIn){const wallet=await connectPlankLoveWallet();const proof=await walletProof(wallet,"charmville","porch",{});token=proof.sessionToken;auth.current=token;generation=accountGeneration.current;}
      if(generation!==accountGeneration.current)return false;
      if(!token)throw new Error("Sign in to use your porch.");
      if(pending.current && JSON.stringify(pending.current.action)!==JSON.stringify(action))throw new Error("Check the pending action before making another change.");
      pending.current ??= {id:crypto.randomUUID(),action};setHasPending(true);
      const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({...action,requestId:pending.current.id})});
      const data=await response.json();
      if(generation!==accountGeneration.current)return false;
      if(!response.ok){if(response.status<500){pending.current=null;setHasPending(false);}throw new Error(data.error);}
      const effectId=pending.current?.id??crypto.randomUUID();
      pending.current=null;setHasPending(false);apply(data);
      if(action.plotIndex!==undefined)setEffect({id:effectId,plotIndex:action.plotIndex,kind:data.action??action.action,qty:Number(data.qty??0)});
      if(action.action==="resolve"){setBag(true);setNotice(data.action==="compost"?"Seed returned. Your plot is ready for another season.":`${data.qty} faces gathered. One seed returned.`);}
      if(action.action==="stamp")setNotice("Stalk stamped onto your Grain. Your seed stays home.");
      if(action.action==="tend")setNotice("A little care left for your neighbor. You earned 1 grain.");
      await refresh();return true;
    } catch(error){if(generation===accountGeneration.current)setNotice(error instanceof Error?error.message:"Please try again");return false;}
    finally{actionRunning.current=false;setBusy(false);}
  }
  const seedCount=(face:string)=>yard?.inventory?.seeds.find(s=>s.face===face)?.qty??"0";
  return <section className={`${styles.porch} ${expanded?styles.expanded:""}`} data-market-shell aria-label="Charmville porch">
    <header className={styles.header}><h2>Charmville</h2><div>
      <button onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>{expanded?"Close the lot":"Open the lot"}</button>
      <button ref={pouch} onClick={()=>setBag(v=>!v)} aria-expanded={bag} className={styles.pouch}><PouchArt /><span>Satchel</span></button>
    </div></header>
    {!online&&<p role="status">Offline. Your porch is safe; reconnect to plant or harvest.</p>}
    {!yard?<p>Opening the porch… <button onClick={()=>void refresh()}>Refresh</button></p>:!yard.claimed?<div className={styles.welcome}>
      <img src="/images/plank-logo.webp" alt="Plank" width="80" height="90" />
      <p>{yard.owner?"Your six plots are waiting. Two Stalks are ready to gather.":"A porch can grow here."}</p>
      <button disabled={busy||!online} onClick={()=>yard.owner?void act({action:"claim"}):void act({action:"claim"},true)}>{yard.owner?"Claim your lot":"Connect to claim your lot"}</button>
    </div>:<>
      <YardScene key={handle+String(yard.owner)} decorations={yard.decorations} layoutRevision={yard.layoutRevision} onLayout={(decorations,revision)=>act({action:"layout",decorations,revision})} plots={yard.plots} now={now} expanded={expanded} owner={yard.owner} disabled={busy||!online||!authenticated} effect={effect}
        onPlot={plot=>void act(yard.owner?{action:plot.crop?"resolve":"plant",plotIndex:plot.plotIndex,revision:plot.revision,...(!plot.crop?{face:planting}:{})}:{action:"tend",plotIndex:plot.plotIndex,revision:plot.revision})}/>
      {yard.owner?<fieldset className={styles.seeds}><legend>Plant your next appointment</legend>{["stalk","splinter"].map(face=><label key={face}><input type="radio" name={`seed-${handle}`} checked={planting===face} onChange={()=>setPlanting(face)}/>{face==="stalk"?"Stalk · 4h · seed only":"Splinter · 16h · seed + 2 grain"}<small>{seedCount(face)} seeds</small></label>)}</fieldset>:<p>Leave a little care on a growing plot. Only the owner can harvest.</p>}
      {!authenticated&&<button disabled={busy} onClick={async()=>{setBusy(true);try{const w=await connectPlankLoveWallet();await walletProof(w,"charmville","porch",{});await refresh();}catch(e){setNotice(e instanceof Error?e.message:"Sign-in failed");}finally{setBusy(false);}}}>Sign in to tend</button>}
    </>}
    <p role="status" className={styles.notice}>{notice}</p>
    {hasPending&&!busy&&<button onClick={()=>void act(pending.current!.action)}>Check / retry pending action</button>}
    {bag&&createPortal(<div className={styles.windowLayer} data-market-shell><div className={styles.window} ref={dialog} tabIndex={-1} role="dialog" aria-label="Satchel" style={{left:position.x,top:position.y}}>
      <header className={styles.windowHeader} onPointerDown={e=>{if((e.target as HTMLElement).closest("button"))return;drag.current={x:e.clientX,y:e.clientY,left:position.x,top:position.y};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(!drag.current)return;setPosition({x:Math.max(0,Math.min(window.innerWidth-(dialog.current?.offsetWidth??410),drag.current.left+e.clientX-drag.current.x)),y:Math.max(0,Math.min(window.innerHeight-Math.min(dialog.current?.offsetHeight??100,window.innerHeight),drag.current.top+e.clientY-drag.current.y))});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><h2>Satchel</h2><button onClick={closeBag} aria-label="Close satchel">×</button></header>
      <div className={styles.inventory}>{yard?.inventory?<><div className={styles.stacks}>{["stalk","splinter"].map(face=><button key={face} aria-pressed={selected===face} onClick={()=>setSelected(face)}><CropArt face={face}/><span>{face}</span><b>{yard.inventory!.faces.find(s=>s.face===face)?.qty??"0"}</b></button>)}</div>
        <div className={styles.selected}><CropArt face={selected}/><span>{selected}</span></div>
        <div className={styles.seedStacks}>{yard.inventory.seeds.map(seed=><span key={seed.face}><CropArt face={seed.face} seed/>{seed.face} seeds <b>{seed.qty}</b></span>)}</div>
        <label className={styles.send}>Send a Stalk stamp to your Grain<select value={postId} onChange={e=>setPostId(e.target.value)}><option value="">Choose a Grain</option>{posts.map(p=><option key={p.id} value={p.id}>{p.body.slice(0,60)}</option>)}</select></label>
        <button disabled={busy||!postId||!online||selected!=="stalk"} onClick={()=>void act({action:"stamp",postId})}>SEND · 1 Stalk</button>
        <footer>{yard.inventory.grain} grain <span>Seeds return. Faces are yours to spend.</span></footer></>:<p>Sign in on your own board to open your inventory.</p>}</div>
      <button className={styles.reset} onClick={()=>setPosition({x:24,y:100})}>Reset window position</button>
    </div></div>,document.body)}
  </section>;
}
