"use client";
/* eslint-disable @next/next/no-img-element */
import {useCallback,useEffect,useRef,useState} from "react";
import Link from "next/link";
import {connectPlankLoveWallet,getPlankLoveWalletState,subscribePlankLoveWalletState} from "./plank-love-wallet";
import {walletProof} from "./auth-client";
import {MediaAttachment,MediaComposer} from "./post-media-ui";
import type {PostMedia} from "./post-media";

type Item={id:string;type:"post"|"knock"|"profile";author:string;handle:string;avatarUrl:string;body:string;createdAt:string;targetHandle?:string;likes?:number;mediaUrl?:string;mediaType?:string;mediaAlt?:string};
type Board={handle:string;displayName:string;mood?:string};
type Mode="global"|"connections";
type Step="idle"|"connecting"|"signing"|"posting"|"loading";
type Tone="info"|"error";

const emptyMedia:PostMedia={mediaUrl:"",mediaType:"",mediaAlt:""};
const DRAFT_KEY="plankspace-lumberyard-draft";
const MAX_LENGTH=500;
const MASCOT="/images/plank-logo.webp";

/** Turn a bridge / API error into copy that names the problem and the way out. */
function explain(error:unknown):{text:string;recovery?:"profile"|"retry"}{
 const raw=error instanceof Error?error.message:"";
 if(/did not finish the wallet request/i.test(raw))return{text:"The wallet request timed out. Open your wallet and try again.",recovery:"retry"};
 if(/create a profile/i.test(raw))return{text:"You need a board before you can post.",recovery:"profile"};
 if(/rejected|denied|cancel/i.test(raw))return{text:"Signature declined. Nothing was posted.",recovery:"retry"};
 if(/wait a few seconds/i.test(raw))return{text:"Easy there — wait a few seconds before posting again."};
 if(raw&&raw.length<140)return{text:raw,recovery:"retry"};
 return{text:"Something went wrong on our side. Try again in a moment.",recovery:"retry"};
}

function relativeTime(iso:string){
 const then=Date.parse(iso);if(Number.isNaN(then))return "";
 const diff=Math.round((Date.now()-then)/1000);
 if(diff<45)return "just now";
 const units:[number,Intl.RelativeTimeFormatUnit][]=[[60,"second"],[60,"minute"],[24,"hour"],[7,"day"],[4.35,"week"],[12,"month"],[Infinity,"year"]];
 let value=diff,unit:Intl.RelativeTimeFormatUnit="second";
 for(const [size,name] of units){unit=name;if(value<size)break;value=value/size}
 return new Intl.RelativeTimeFormat("en",{numeric:"auto"}).format(-Math.round(value),unit);
}

function readDraft(){try{return localStorage.getItem(DRAFT_KEY)||""}catch{return ""}}
function writeDraft(value:string){try{if(value)localStorage.setItem(DRAFT_KEY,value);else localStorage.removeItem(DRAFT_KEY)}catch{/* private mode */}}

function HeartIcon(){return <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M8 13.5 2.9 8.6a2.9 2.9 0 0 1 4.1-4.1L8 5.5l1-1a2.9 2.9 0 0 1 4.1 4.1Z"/></svg>}

function KindLabel({item}:{item:Item}){
 if(item.type==="knock")return <span className="activity-kind">Knocked on {item.targetHandle?<Link href={`/u/${item.targetHandle}`}>@{item.targetHandle}</Link>:"a board"}</span>;
 if(item.type==="profile")return <span className="activity-kind">New mood</span>;
 return <span className="activity-kind">Posted to the Lumberyard</span>;
}

export default function HomeFeed(){
 const [items,setItems]=useState<Item[]>([]);
 const [mode,setMode]=useState<Mode>("global");
 const [loading,setLoading]=useState(true);
 const [feedError,setFeedError]=useState("");
 const [step,setStep]=useState<Step>("idle");
 const [notice,setNotice]=useState<{text:string;tone:Tone;recovery?:"profile"|"retry"}|null>(null);
 const [body,setBody]=useState("");
 const [media,setMedia]=useState<PostMedia>(emptyMedia);
 const [wallet,setWallet]=useState<string|null>(null);
 const [featured,setFeatured]=useState<Board|null>(null);
 const attempt=useRef(0);
 const textareaRef=useRef<HTMLTextAreaElement>(null);
 const tabRefs=useRef<(HTMLButtonElement|null)[]>([]);

 // Wallet state: read on mount and follow the shared Plank.love session.
 useEffect(()=>{
  const unsubscribe=subscribePlankLoveWalletState(state=>setWallet(state.address?state.address.toLowerCase():null));
  void getPlankLoveWalletState().then(state=>setWallet(state.address?state.address.toLowerCase():null)).catch(()=>undefined);
  return unsubscribe;
 },[]);

 // Draft survives the wallet round-trip and accidental reloads.
 useEffect(()=>{const draft=readDraft();if(draft)queueMicrotask(()=>setBody(draft))},[]);
 useEffect(()=>{writeDraft(body)},[body]);

 const loadGlobal=useCallback(()=>{
  const id=++attempt.current;
  setLoading(true);setFeedError("");setMode("global");
  fetch("/api/feed").then(async r=>{const d=await r.json().catch(()=>({}));if(id!==attempt.current)return;if(!r.ok||d.error){setItems([]);setFeedError(d.error||"The Lumberyard feed is unavailable right now.")}else setItems(d.items||[])})
   .catch(()=>{if(id===attempt.current){setItems([]);setFeedError("The Lumberyard feed is unavailable right now.")}})
   .finally(()=>{if(id===attempt.current)setLoading(false)});
 },[]);
 useEffect(()=>{queueMicrotask(loadGlobal)},[loadGlobal]);

 // A fresh board for the aside — never a hardcoded handle.
 useEffect(()=>{
  fetch("/api/profiles").then(r=>r.json()).then(d=>{const first=(d.profiles||[])[0];if(first?.handle)setFeatured({handle:first.handle,displayName:first.displayName||first.handle,mood:first.mood})}).catch(()=>undefined);
 },[]);

 const cancel=()=>{attempt.current+=1;setStep("idle");setNotice(null);setLoading(false)};

 const connect=async()=>{
  const id=++attempt.current;
  setStep("connecting");setNotice({text:"Connect the wallet that owns your board.",tone:"info"});
  try{const address=await connectPlankLoveWallet();if(id!==attempt.current)return;setWallet(address);setStep("idle");setNotice(null)}
  catch(e){if(id!==attempt.current)return;setStep("idle");setNotice({...explain(e),tone:"error"})}
 };

 const loadConnections=async()=>{
  const id=++attempt.current;
  setLoading(true);setFeedError("");setNotice(null);
  try{
   setStep("connecting");
   const address=await connectPlankLoveWallet();if(id!==attempt.current)return;setWallet(address);
   setStep("signing");setNotice({text:"Sign once to prove it's your board. Login-only — no gas, nothing moves.",tone:"info"});
   const data={mode:"connections"},proof=await walletProof(address,"feed:connections","lumberyard",data);if(id!==attempt.current)return;
   setStep("loading");setNotice(null);
   const r=await fetch("/api/feed",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,...data})}),d=await r.json().catch(()=>({}));if(id!==attempt.current)return;
   if(!r.ok||d.error)throw new Error(d.error||"Your connections feed is unavailable right now.");
   setItems(d.items||[]);setMode("connections");setStep("idle");
  }catch(e){if(id!==attempt.current)return;setStep("idle");setMode("global");setNotice({...explain(e),tone:"error"})}
  finally{if(id===attempt.current)setLoading(false)}
 };

 const post=async()=>{
  const text=body.trim();if(!text||step!=="idle")return;
  const id=++attempt.current;
  setNotice(null);
  try{
   setStep("connecting");
   const address=await connectPlankLoveWallet();if(id!==attempt.current)return;setWallet(address);
   setStep("signing");setNotice({text:"Sign once to publish as your board. Login-only — no gas, nothing moves.",tone:"info"});
   const data={body:text,...media},proof=await walletProof(address,"post:create","lumberyard",data);if(id!==attempt.current)return;
   setStep("posting");setNotice({text:"Nailing it to the board…",tone:"info"});
   const r=await fetch("/api/posts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,...data})}),d=await r.json().catch(()=>({}));if(id!==attempt.current)return;
   if(!r.ok||d.error)throw new Error(d.error||"Post failed.");
   setBody("");setMedia(emptyMedia);writeDraft("");setStep("idle");
   setNotice({text:"Posted. It's on the Lumberyard now.",tone:"info"});
   loadGlobal();
  }catch(e){if(id!==attempt.current)return;setStep("idle");setNotice({...explain(e),tone:"error"})}
 };

 const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{if((event.metaKey||event.ctrlKey)&&event.key==="Enter"){event.preventDefault();void post()}};

 const onTabKey=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
  const order:Mode[]=["global","connections"];let next=index;
  if(event.key==="ArrowRight"||event.key==="ArrowDown")next=(index+1)%order.length;
  else if(event.key==="ArrowLeft"||event.key==="ArrowUp")next=(index-1+order.length)%order.length;
  else if(event.key==="Home")next=0;else if(event.key==="End")next=order.length-1;else return;
  event.preventDefault();tabRefs.current[next]?.focus();
 };

 const busy=step!=="idle";
 const remaining=MAX_LENGTH-body.length;
 const canPost=Boolean(body.trim())&&!busy;

 return <div className="home-feed">
  <header className="lumberyard-page-header">
   <div><small>YOUR PLACE IN THE LUMBERYARD</small><h1>Build a board that feels like you.</h1><p>Create a wallet-owned PlankSpace profile, then customize its layout, widgets, and style.</p></div>
   <div><Link className="lumberyard-profile-action" href={wallet?"/profile-editor":"/create-profile"}>{wallet?"Edit Profile":"Create Profile"}</Link><Link className="lumberyard-profile-action is-secondary" href="/browse">Browse Profiles</Link></div>
  </header>
  <main id="main-content" tabIndex={-1}>
   <aside aria-labelledby="lumberyard-title">
    <img className="lumberyard-mascot" src={MASCOT} alt="" width={132} height={132}/>
    <h1 id="lumberyard-title">The Lumberyard</h1>
    <p>Every post, mood change, and knock from boards across PlankSpace, newest first.</p>
    <nav className="lumberyard-links" aria-label="Lumberyard shortcuts">
     <Link href="/browse">Browse boards</Link>
     {featured&&<Link href={`/u/${featured.handle}`}>Fresh board <small>{featured.displayName}</small></Link>}
     {wallet?<Link href="/profile-editor">Customize my board</Link>:<Link href="/create-profile">Create your board</Link>}
     <Link href="/planks-list">My planks list</Link>
    </nav>
   </aside>

   <section aria-label="Lumberyard feed">
    <div className="feed-hero">
     <h2>What&apos;s on your grain?</h2>
     <textarea ref={textareaRef} value={body} onChange={e=>setBody(e.target.value.slice(0,MAX_LENGTH))} onKeyDown={onKeyDown} maxLength={MAX_LENGTH} placeholder="Post an update to every board…" aria-label="Post an update" aria-describedby="lumberyard-hint" disabled={step==="posting"}/>
     <MediaComposer value={media} onChange={setMedia} idPrefix="home-feed"/>
     <div className="feed-hero-row">
      <div className="feed-hero-meta" data-near-limit={remaining<=40}>
       <span aria-live="polite">{body.length} / {MAX_LENGTH}</span>
       <span aria-hidden="true">Ctrl + Enter to post</span>
      </div>
      {wallet
       ?<button type="button" className="feed-submit" disabled={!canPost} onClick={post}>{step==="posting"?"Posting…":step==="signing"?"Waiting for signature…":"Post to Lumberyard"}</button>
       :<button type="button" className="feed-submit" data-intent="connect" disabled={busy} onClick={connect}>{step==="connecting"?"Opening wallet…":"Connect wallet to post"}</button>}
     </div>
     <p id="lumberyard-hint" className="feed-hero-hint">Posts publish under your <Link href="/help">board</Link> — your wallet-owned PlankSpace profile. A <em>knock</em> is a note left on someone else&apos;s board. Posting asks for a login-only signature; it never spends anything.</p>
    </div>

    {notice&&<div className="feed-status" role="status" aria-live="polite" data-tone={notice.tone}>
     <p>{busy&&<span className="feed-status-spinner" aria-hidden="true"/>}<span>{notice.text}{notice.recovery==="profile"&&<> <Link href="/create-profile">Create your board</Link>.</>}</span></p>
     {busy?<button type="button" onClick={cancel}>Cancel</button>:<button type="button" onClick={()=>setNotice(null)} aria-label="Dismiss">Dismiss</button>}
    </div>}

    <div className="feed-tabs" role="tablist" aria-label="Feed scope">
     <button ref={el=>{tabRefs.current[0]=el}} role="tab" id="lumberyard-tab-global" aria-selected={mode==="global"} aria-controls="lumberyard-feed" tabIndex={mode==="global"?0:-1} onClick={loadGlobal} onKeyDown={e=>onTabKey(e,0)}>Everyone</button>
     <button ref={el=>{tabRefs.current[1]=el}} role="tab" id="lumberyard-tab-connections" aria-selected={mode==="connections"} aria-controls="lumberyard-feed" tabIndex={mode==="connections"?0:-1} onClick={loadConnections} onKeyDown={e=>onTabKey(e,1)}>My connections</button>
    </div>

    <div id="lumberyard-feed" role="tabpanel" aria-labelledby={mode==="global"?"lumberyard-tab-global":"lumberyard-tab-connections"}>
     {loading
      ?<div className="activity-feed" aria-busy="true" aria-label="Loading the Lumberyard">
        <div className="feed-skeleton"><i/><div><i/><i/><i/></div></div>
        <div className="feed-skeleton"><i/><div><i/><i/><i/></div></div>
       </div>
      :feedError
      ?<div className="feed-state" role="alert">
        <img src={MASCOT} alt="" width={72} height={72}/>
        <div><h3>The sawmill is down for a minute.</h3><p>{feedError}</p>
         <div className="feed-state-actions"><button type="button" onClick={mode==="connections"?loadConnections:loadGlobal}>Try again</button><Link className="is-secondary" href="/browse">Browse boards instead</Link></div></div>
       </div>
      :items.length===0
      ?<div className="feed-state">
        <img src={MASCOT} alt="" width={72} height={72}/>
        <div><h3>{mode==="connections"?"Your connections are quiet.":"The Lumberyard is quiet."}</h3>
         <p>{mode==="connections"?"Add friends, favorites, or a Top 8 on your board and their posts land here.":"Be the first to post today, or wander the boards and knock on one."}</p>
         <div className="feed-state-actions">{mode==="connections"?<Link href="/browse">Find boards to follow</Link>:<button type="button" onClick={()=>textareaRef.current?.focus()}>Write a post</button>}<Link className="is-secondary" href="/browse">Browse boards</Link></div></div>
       </div>
      :<div className="activity-feed">
        {items.map(item=><article key={item.id} className={`activity-${item.type}`}>
         <Link className="activity-avatar" href={`/u/${item.handle}`} aria-label={`${item.author}'s board`}><img src={item.avatarUrl||"/plank-classic.jpeg"} alt="" width={52} height={58}/></Link>
         <div>
          <div className="activity-head"><h3><Link href={`/u/${item.handle}`}>{item.author}</Link></h3><KindLabel item={item}/></div>
          <p>{item.body}</p>
          <MediaAttachment mediaUrl={item.mediaUrl} mediaType={item.mediaType} mediaAlt={item.mediaAlt}/>
          <div className="activity-foot">
           <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</time>
           {typeof item.likes==="number"&&<span className="activity-likes" aria-label={`${item.likes} likes`}><HeartIcon/>{item.likes}</span>}
          </div>
         </div>
        </article>)}
       </div>}
    </div>
   </section>
  </main>
 </div>;
}
