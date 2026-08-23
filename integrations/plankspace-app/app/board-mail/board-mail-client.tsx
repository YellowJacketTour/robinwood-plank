"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import {useMemo, useState} from "react";
import {walletProof} from "../auth-client";
import {connectPlankLoveWallet} from "../plank-love-wallet";

type Mail={id:number;senderWallet:string;senderHandle:string;recipientWallet:string;recipientHandle:string;subject:string;body:string;readAt:string|null;createdAt:string};
type Note={id:number;body:string;href:string;createdAt:string};
type Profile={handle:string;displayName:string;avatarUrl:string;bio:string;mood:string};

async function json<T>(response:Response):Promise<T>{
 const raw=await response.text();
 let payload:Record<string,unknown>={};
 try{payload=raw?JSON.parse(raw):{}}catch{}
 if(!response.ok)throw new Error(typeof payload.error==="string"?payload.error:`Board Mail request failed (${response.status})`);
 return payload as T;
}

export default function BoardMailClient(){
 const [wallet,setWallet]=useState("");
 const [items,setItems]=useState<Mail[]>([]);
 const [notes,setNotes]=useState<Note[]>([]);
 const [profiles,setProfiles]=useState<Profile[]>([]);
 const [recipient,setRecipient]=useState("");
 const [selectedRecipient,setSelectedRecipient]=useState<Profile|null>(null);
 const [showResults,setShowResults]=useState(false);
 const [subject,setSubject]=useState("");
 const [body,setBody]=useState("");
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);

 const matches=useMemo(()=>{
  const query=recipient.trim().toLowerCase().replace(/^@/,"");
  if(!query)return profiles.slice(0,8);
  return profiles.filter(profile=>profile.handle.includes(query)||profile.displayName.toLowerCase().includes(query)).slice(0,8);
 },[profiles,recipient]);

 const choose=(profile:Profile)=>{setSelectedRecipient(profile);setRecipient(profile.handle);setShowResults(false);setMessage("")};
 const changeRecipient=(value:string)=>{setRecipient(value);setSelectedRecipient(null);setShowResults(true)};

 const open=async()=>{
  setBusy(true);setMessage("");
  try{
   const w=await connectPlankLoveWallet();setWallet(w);
   const mailData={action:"list"},mailProof=await walletProof(w,"mail:list","inbox",mailData);
   const mail=await json<{messages?:Mail[]}>(await fetch("/api/mail",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...mailProof,...mailData})}));
   setItems(mail.messages||[]);
   const [profileData,noteData]=await Promise.all([
    json<{profiles?:Profile[]}>(await fetch("/api/profiles",{cache:"no-store"})),
    (async()=>{const data={action:"list"},proof=await walletProof(w,"notifications:list","self",data);return json<{notifications?:Note[]}>(await fetch("/api/notifications",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,...data})}))})(),
   ]);
   setProfiles(profileData.profiles||[]);
   setNotes(noteData.notifications||[]);
  }catch(error){setMessage(error instanceof Error?error.message:"Board Mail unavailable")}
  finally{setBusy(false)}
 };

 const send=async()=>{
  setBusy(true);setMessage("");
  try{
   const w=wallet||await connectPlankLoveWallet();
   const handle=(selectedRecipient?.handle||recipient).trim().toLowerCase().replace(/^@/,"");
   const match=profiles.find(profile=>profile.handle===handle);
   if(!match)throw new Error("Select an approved PlankSpace profile from the recipient list.");
   const data={recipientHandle:match.handle,subject:subject.trim()||"Board Mail",body:body.trim()};
   const proof=await walletProof(w,"mail:send",data.recipientHandle,data);
   const result=await json<{message:Mail}>(await fetch("/api/mail",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...proof,action:"send",...data})}));
   setItems(value=>[result.message,...value]);setRecipient("");setSelectedRecipient(null);setSubject("");setBody("");setMessage(`Board Mail sent to @${match.handle}.`);
  }catch(error){setMessage(error instanceof Error?error.message:"Mail failed")}
  finally{setBusy(false)}
 };

 const inbox=items.filter(item=>item.recipientWallet===wallet),sent=items.filter(item=>item.senderWallet===wallet);
 return <div className="mail-shell"><header><Link className="brand" href="/plankspace">plank<span>space</span></Link><b>BOARD MAIL</b><Link href="/browse">Find Boards</Link></header><main><section className="mail-hero"><small>PRIVATE WALLET-OWNED MAIL</small><h1>Your wooden inbox.</h1><p>Messages and notifications belong to your connected Plank.love wallet.</p>{!wallet&&<button onClick={open} disabled={busy}>{busy?"Opening…":"Connect, Sign & Open Mail"}</button>}{message&&<p role="status">{message}</p>}</section>{wallet&&<><section className="mail-compose"><h2>Carve a new message</h2><div className="mail-recipient"><label htmlFor="mail-recipient">To</label><input id="mail-recipient" role="combobox" aria-autocomplete="list" aria-expanded={showResults} aria-controls="mail-recipient-results" autoComplete="off" value={recipient} onChange={event=>changeRecipient(event.target.value)} onFocus={()=>setShowResults(true)} placeholder="Search username or display name"/>{showResults&&<div id="mail-recipient-results" className="mail-recipient-results" role="listbox">{matches.map(profile=><button type="button" role="option" aria-selected={selectedRecipient?.handle===profile.handle} key={profile.handle} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(profile)}><img src={profile.avatarUrl||"/plank-classic.jpeg"} alt=""/><span><b>{profile.displayName}</b><small>@{profile.handle}</small></span></button>)}{!matches.length&&<p>No approved profiles match that search.</p>}</div>}{selectedRecipient&&<p className="mail-recipient-selected">Mailing <b>{selectedRecipient.displayName}</b> (@{selectedRecipient.handle}) <button type="button" onClick={()=>changeRecipient("")} aria-label="Clear recipient">×</button></p>}</div><input value={subject} onChange={event=>setSubject(event.target.value)} maxLength={80} placeholder="Subject"/><textarea value={body} onChange={event=>setBody(event.target.value)} maxLength={1000} placeholder="Write your Board Mail…"/><button onClick={send} disabled={busy||!selectedRecipient||!body.trim()}>{busy?"Sending…":"Sign & Send"}</button></section><div className="mail-columns"><section><h2>Inbox ({inbox.length})</h2>{inbox.map(item=><article key={item.id}><b>@{item.senderHandle} · {item.subject}</b><p>{item.body}</p><time>{new Date(item.createdAt).toLocaleString()}</time></article>)}{!inbox.length&&<p>No mail yet.</p>}</section><section><h2>Sent ({sent.length})</h2>{sent.map(item=><article key={item.id}><b>To @{item.recipientHandle} · {item.subject}</b><p>{item.body}</p><time>{new Date(item.createdAt).toLocaleString()}</time></article>)}{!sent.length&&<p>No sent mail yet.</p>}</section><section><h2>Notifications ({notes.length})</h2>{notes.map(note=><article key={note.id}><Link href={note.href}>{note.body}</Link><time>{new Date(note.createdAt).toLocaleString()}</time></article>)}{!notes.length&&<p>No notifications yet.</p>}</section></div></>}</main></div>
}
