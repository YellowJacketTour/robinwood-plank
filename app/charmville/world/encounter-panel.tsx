"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {savedWalletProof} from '@/integrations/plankspace-app/app/auth-client';
type Action='claim'|'enter-turn'|'return-world'|'release';
type Snapshot={profileId:string;actorEpoch:number;inRange:boolean;legalActions:Action[];encounter:{id:string;speciesId:number;name:string;level:number;hp:number;maxHp:number;statuses:string[];mode:'world'|'turn';controllerId:string|null;revision:string}};
type Command={requestId:string;encounterId:string;revision:string;actorEpoch:number;action:Action};
const labels:Record<Action,string>={claim:'Meet Poochyena','enter-turn':'Inspect','return-world':'Return to world',release:'Leave encounter'};
export default function EncounterPanel({wallet,active}:{wallet:string;active:boolean}){
 const [state,setState]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[retry,setRetry]=useState(false);
 const pending=useRef<Command|null>(null),abort=useRef<AbortController|null>(null),epoch=useRef(0),running=useRef(false);
 const request=useCallback(async(command?:Command)=>{
  if(running.current&&!command)return;if(command)abort.current?.abort();running.current=true;const version=++epoch.current;const controller=new AbortController();abort.current=controller;
  if(command){setBusy(true);setMessage('');}
  try{const proof=await savedWalletProof(wallet);if(controller.signal.aborted||version!==epoch.current)return;if(!proof.sessionToken){setState(null);return;}
   const response=await fetch('/api/charmville/world/encounter',{method:command?'POST':'GET',headers:{authorization:`Bearer ${proof.sessionToken}`,'Content-Type':'application/json'},body:command?JSON.stringify(command):undefined,cache:'no-store',mode:'same-origin',redirect:'error',signal:controller.signal});
   const data=await response.json();if(controller.signal.aborted||version!==epoch.current)return;
   if(!response.ok){if(command&&[400,403,404,409,422].includes(response.status)){pending.current=null;setRetry(false);}if(!command){setState(null);return;}throw new Error(data.error??'Encounter could not be confirmed.');}
   setState(data);if(command){pending.current=null;setRetry(false);setMessage(command.action==='release'?'Encounter released.':'Encounter updated.');}
  }catch(error){if(!controller.signal.aborted&&version===epoch.current&&command){setRetry(!!pending.current);setMessage(error instanceof Error?error.message:'Connection interrupted. Retry to check the same action.');}}
  finally{if(version===epoch.current){running.current=false;setBusy(false);}}
 },[wallet]);
 useEffect(()=>{if(!active)return;const epochs=epoch;let disposed=false;void Promise.resolve().then(()=>{if(!disposed){setState(null);pending.current=null;setRetry(false);setMessage('');void request();}});const timer=setInterval(()=>{if(document.visibilityState==='visible')void request();},2000);return()=>{disposed=true;clearInterval(timer);++epochs.current;abort.current?.abort();running.current=false;};},[active,request]);
 if(!active||!state||(!state.inRange&&state.encounter.controllerId!==state.profileId))return null;
 const encounter=state.encounter;
 return <section aria-label="Nearby encounter" className="mt-3 rounded-xl border border-line-strong bg-wood-900 p-4 text-cream"><div className="flex items-center justify-between gap-3"><h3 className="font-display text-xl text-gold-300">{encounter.name}</h3><span>Level {encounter.level}</span></div><div role="img" aria-label="Poochyena source portrait" className="mx-auto my-2 h-16 w-16" style={{backgroundImage:"url(/charmville/creatures/poochyena-front.png)",backgroundPosition:"0 0",backgroundRepeat:"no-repeat",imageRendering:"pixelated"}}/><p className="mt-2 text-sm">HP {encounter.hp} / {encounter.maxHp}</p><meter aria-label="Wild creature HP" min={0} max={encounter.maxHp} value={encounter.hp} className="w-full"/><p className="my-2 text-sm text-cream-muted">{encounter.controllerId&&encounter.controllerId!==state.profileId?'Another player is meeting this creature.':encounter.mode==='turn'?'Inspecting this creature. Combat and capture are not available yet.':'A wild creature is nearby.'}</p><div className="flex flex-wrap gap-2">{state.legalActions.filter(action=>action in labels).map(action=><button key={action} type="button" className="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50" disabled={busy||retry} onClick={()=>{const command={requestId:crypto.randomUUID(),encounterId:encounter.id,revision:encounter.revision,actorEpoch:state.actorEpoch,action};pending.current=command;void request(command);}}>{labels[action]}</button>)}{retry&&<button type="button" className="min-h-11 rounded-lg border border-line px-4 py-2 text-gold-300" disabled={busy} onClick={()=>{if(pending.current)void request(pending.current);}}>Retry encounter action</button>}</div>{message&&<p role="status" className="mt-2 text-sm">{message}</p>}</section>;
}
