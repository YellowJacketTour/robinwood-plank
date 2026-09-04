"use client";
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import { savedWalletProof, walletProof } from "./auth-client";
import { getPlankLoveWalletState } from "./plank-love-wallet";

type Visitor={handle:string;displayName:string;avatarUrl:string;visitedAt:string};
type Publication={id:number;title:string;body:string;createdAt:string};

export function ProfileVisitTracker({handle,initialCount}:{handle:string;initialCount:number}){
 const [count,setCount]=useState(initialCount);
 useEffect(()=>{const key=`plankspace:visit:${handle}`;if(sessionStorage.getItem(key))return;sessionStorage.setItem(key,"1");void(async()=>{try{const state=await getPlankLoveWalletState(),wallet=state.address?.toLowerCase()||"",proof=wallet?await savedWalletProof(wallet):{};const response=await fetch("/api/profile-visits",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,handle,wallet})});if(response.ok){const result=await response.json();setCount(result.viewCount??initialCount)}}catch{}})()},[handle,initialCount]);
 return <span className="profile-view-count" title="Profile views">👁 {count.toLocaleString()} views</span>;
}

export function RecentVisitors({handle}:{handle:string}){
 const [items,setItems]=useState<Visitor[]>([]);
 useEffect(()=>{fetch(`/api/profile-visits?handle=${encodeURIComponent(handle)}`).then(r=>r.ok?r.json():Promise.reject()).then(data=>setItems(data.visitors||[])).catch(()=>undefined)},[handle]);
 return items.length?<div className="recent-visitors">{items.slice(0,8).map(visitor=><a key={visitor.handle} href={`/u/${visitor.handle}`} title={`${visitor.displayName} visited recently`}><img src={visitor.avatarUrl||"/plank-classic.jpeg"} alt=""/><span>{visitor.displayName}</span></a>)}</div>:<p className="public-empty">No signed-in visitors yet.</p>;
}

export function Publications({handle,kind}:{handle:string;kind:"bulletin"|"blog"}){
 const [items,setItems]=useState<Publication[]>([]),[open,setOpen]=useState(false),[title,setTitle]=useState(""),[body,setBody]=useState(""),[message,setMessage]=useState("");
 const load=useCallback(()=>fetch(`/api/publications?handle=${encodeURIComponent(handle)}&kind=${kind}`).then(r=>r.json()).then(data=>setItems(data.items||[])).catch(()=>setMessage("Updates are unavailable.")),[handle,kind]);
 useEffect(()=>{load()},[load]);
 const publish=async()=>{setMessage("");try{const state=await getPlankLoveWalletState(),wallet=state.address?.toLowerCase();if(!wallet)throw new Error("Connect your Plank.love wallet first.");const data={ownerHandle:handle,kind,title:title.trim(),body:body.trim()},proof=await walletProof(wallet,"publication:create",`${handle}:${kind}`,data),response=await fetch("/api/publications",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,...data})}),result=await response.json();if(!response.ok)throw new Error(result.error||"Could not publish");setTitle("");setBody("");setOpen(false);load()}catch(error){setMessage(error instanceof Error?error.message:"Could not publish")}};
 return <div className={`profile-publications ${kind}`}><button className="publication-toggle" onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open?"Cancel":kind==="bulletin"?"Post a Bulletin":"Write a Blog Entry"}</button>{open&&<div className="publication-composer"><input value={title} onChange={event=>setTitle(event.target.value)} maxLength={100} placeholder="Title"/><textarea value={body} onChange={event=>setBody(event.target.value)} maxLength={5000} placeholder="Write something for your board…"/><button onClick={publish} disabled={!title.trim()||!body.trim()}>Publish</button></div>}{message&&<p role="alert">{message}</p>}<div className="publication-list">{items.map(item=><article key={item.id}><h3>{item.title}</h3><time>{new Date(item.createdAt).toLocaleDateString()}</time><p>{item.body}</p></article>)}{!items.length&&!message&&<p className="public-empty">Nothing posted yet.</p>}</div></div>;
}
