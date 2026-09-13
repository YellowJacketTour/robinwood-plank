"use client";
import {NATIVE_RUNTIME_ORIGIN as DEFAULT_RUNTIME_ORIGIN} from './native-runtime';
import {useEffect,useState,type RefObject} from 'react';
import {createNativeMovementClient,type SavedActor} from '@/lib/charmville/native-movement-client';
import {createWorldSocket} from '@/lib/charmville/world-socket-client';
import {acceptsRegionProjection} from '@/lib/charmville/region-projection';
export type RegionMapState=SavedActor&{peers?:Array<{profileId:string;handle:string;cell:{x:number;y:number}}>};
export function useNativeMovement(frame:RefObject<HTMLIFrameElement|null>,session:RefObject<{token:string}|null>,accountId:string|undefined,admission:string|undefined,onEncounter?: (state:unknown|null)=>void,runtimeOrigin=DEFAULT_RUNTIME_ORIGIN){
 const [status,setStatus]=useState('');
 const [map,setMap]=useState<{admission:string;state:RegionMapState}|null>(null);
 useEffect(()=>{
  if(!runtimeOrigin)return;
  let disposed=false,polling=false;
  const controller=new AbortController();
  const sendPeers=(peers:unknown[]=[],native={dmap:4,screen:63})=>frame.current?.contentWindow?.postMessage({type:'charmville:account-peers',active:true,peers,native},runtimeOrigin);
  sendPeers();
  const token=session.current?.token;
  if(!token||!accountId||!admission)return;
  let projected:RegionMapState|null=null;
  const expectedRegion=admission.slice(0,admission.lastIndexOf(':'));
  const project=(state:RegionMapState)=>{
   if(disposed||!acceptsRegionProjection(projected,state,accountId,expectedRegion))return false;
   // A movement acknowledgment may omit peers; retain the last full interest set
   // only within the same region epoch. Explicit [] means everyone has left.
   const peers=state.peers??(projected?.regionEpoch===state.regionEpoch?projected.peers:[]);
   projected={...state,peers};
   setMap({admission,state:projected});
   sendPeers((peers??[]).filter(p=>p.profileId!==accountId&&p.cell&&Number.isFinite(p.cell.x)&&Number.isFinite(p.cell.y)).map(p=>({profileId:p.profileId,handle:p.handle,x:p.cell.x*state.tilePixels,y:p.cell.y*state.tilePixels})),state.native);
   return true;
  };
  let wire:ReturnType<typeof createWorldSocket>|undefined;
  const request=async(body?:object,signal?:AbortSignal)=>{
   if(body&&wire?.available()){const data=await wire.step(body);project(data as RegionMapState);return data;}
   const response=await fetch('/api/charmville/world/actor',{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'Your position could not be synchronized.');
   project(data);
   return data as SavedActor;
  };
  const client=createNativeMovementClient({allowArrivalWarp:true,allowBorderTravel:true,request,correct(payload){if(!disposed)frame.current?.contentWindow?.postMessage(payload,runtimeOrigin);},status(message){if(!disposed)setStatus(message);},diagnostic(event){if(!disposed&&['localhost','127.0.0.1'].includes(window.location.hostname))console.info('CHARMVILLE_MOVEMENT',JSON.stringify(event));}});
  if(['localhost','127.0.0.1'].includes(window.location.hostname))wire=createWorldSocket(token,snapshot=>{
   if(disposed)return;
   if(project(snapshot as RegionMapState))client.synchronize(snapshot);
  },()=>{if(!disposed){sendPeers();if(projected)projected={...projected,peers:[]};setMap(null);}},snapshot=>{if(!disposed)onEncounter?.(snapshot);});
  const receive=(event:MessageEvent)=>{if(event.origin!==runtimeOrigin||!frame.current||event.source!==frame.current.contentWindow)return;void client.observe(event.data);};
  window.addEventListener('message',receive);
  const timer=setInterval(()=>{if(wire?.available()||polling||document.hidden||!frame.current)return;polling=true;void request(undefined,controller.signal).then(snapshot=>{if(!disposed)client.synchronize(snapshot);}).catch(()=>{if(!disposed){sendPeers();if(projected)projected={...projected,peers:[]};setMap(null);}}).finally(()=>{polling=false;});},2000);
  // Bounded, local-only operational data. No tokens, identity, inputs or payloads.
  const diagnostics=['localhost','127.0.0.1'].includes(window.location.hostname)?setInterval(()=>{
   if(!disposed&&!document.hidden)console.info('CHARMVILLE_MOVEMENT_HEALTH',JSON.stringify(client.metrics()));
  },10000):undefined;
  return()=>{disposed=true;wire?.dispose();controller.abort();clearInterval(timer);clearInterval(diagnostics);client.dispose();sendPeers();window.removeEventListener('message',receive);};
 },[frame,session,accountId,admission,onEncounter,runtimeOrigin]);
 return {status:accountId&&admission?status:'',map:accountId&&admission&&map?.admission===admission&&map.state.profileId===accountId?map.state:null};
}
