"use client";
import {useEffect,useRef,useState} from 'react';
import {savedWalletProof} from '@/integrations/plankspace-app/app/auth-client';
import type {Participant} from './encounter-scene';
type Command={helperProfileId:string;requestId:string;revision:string;actorEpoch:number};
export default function AssistInvitation({wallet,revision,actorEpoch,participants,onChanged}:{wallet:string;revision:string;actorEpoch:number;participants:Participant[];onChanged:()=>void}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[retry,setRetry]=useState(false),[expiresAt,setExpiresAt]=useState<string|null>(null);
 const pending=useRef<Command|null>(null),abort=useRef<AbortController|null>(null),epoch=useRef(0);
 useEffect(()=>()=>{++epoch.current;abort.current?.abort();},[wallet]);
 async function invite(command:Command){
  const version=++epoch.current,controller=new AbortController();abort.current=controller;setBusy(true);setMessage('');
  try{const proof=await savedWalletProof(wallet);if(controller.signal.aborted)return;if(!proof.sessionToken)throw new Error('Reconnect your account to invite a friend.');
   const response=await fetch('/api/charmville/world/battle/assist',{method:'POST',headers:{authorization:`Bearer ${proof.sessionToken}`,'Content-Type':'application/json'},body:JSON.stringify(command),cache:'no-store',mode:'same-origin',redirect:'error',signal:controller.signal});const data=await response.json();if(controller.signal.aborted||epoch.current!==version)return;
   if(!response.ok){if([400,403,404,409,422].includes(response.status)){pending.current=null;setRetry(false);}throw new Error(data.error??'Invitation could not be confirmed.');}
   pending.current=null;setRetry(false);setExpiresAt(data.expiresAt);setMessage('Invitation sent. Your friend may choose one companion move.');onChanged();
  }catch(error){if(!controller.signal.aborted&&epoch.current===version){setRetry(!!pending.current);setMessage(error instanceof Error?error.message:'Invitation unavailable.');}}
  finally{if(epoch.current===version)setBusy(false);}
 }
 if(!participants.length)return null;
 const button='min-h-11 rounded-lg border border-line px-3 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50';
 return <section aria-label="Invite an assist" className="my-3 border-t border-line pt-3"><h4 className="font-bold text-gold-300">Ask a friend to help</h4><p className="my-2 text-sm text-cream-muted">Invite one nearby player for one move. They choose whether to help.</p><div className="flex flex-wrap gap-2">{participants.map(player=><button type="button" key={player.profileId} className={button} disabled={busy||retry} onClick={()=>{if(pending.current)return;const command={helperProfileId:player.profileId,requestId:crypto.randomUUID(),revision,actorEpoch};pending.current=command;void invite(command);}}>Invite @{player.handle}</button>)}</div>{retry&&<button type="button" className={`${button} mt-2`} disabled={busy} onClick={()=>{if(pending.current)void invite(pending.current);}}>Retry invitation</button>}{expiresAt&&<p className="mt-2 text-xs text-cream-muted">This invitation expires at {new Date(expiresAt).toLocaleTimeString()}. A new invitation requires a fresh confirmation.</p>}{message&&<p role="status" className="mt-2 text-sm">{message}</p>}</section>;
}
