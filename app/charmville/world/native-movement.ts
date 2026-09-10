"use client";
import {useEffect,useState,type RefObject} from 'react';
import {createNativeMovementClient,type SavedActor} from '@/lib/charmville/native-movement-client';
import {createWorldSocket} from '@/lib/charmville/world-socket-client';
export function useNativeMovement(frame:RefObject<HTMLIFrameElement|null>,session:RefObject<{token:string}|null>,accountId:string|undefined,admission:string|undefined){
 const [status,setStatus]=useState('');
 useEffect(()=>{
  let disposed=false,polling=false;
  const controller=new AbortController();
  const sendPeers=(peers:unknown[]=[])=>frame.current?.contentWindow?.postMessage({type:'charmville:account-peers',active:true,peers},'http://localhost:3021');
  sendPeers();
  const token=session.current?.token;
  if(!token||!accountId||!admission)return;
  let wire:ReturnType<typeof createWorldSocket>|undefined;
  const request=async(body?:object,signal?:AbortSignal)=>{
   if(body&&wire?.available())return wire.step(body);
   const response=await fetch('/api/charmville/world/actor',{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'Your position could not be synchronized.');
   if(!disposed&&Array.isArray(data.peers))sendPeers(data.peers.map((p:{profileId:string;handle:string;cell:{x:number;y:number}})=>({profileId:p.profileId,handle:p.handle,x:p.cell.x*data.tilePixels,y:p.cell.y*data.tilePixels})));
   return data as SavedActor;
  };
  const client=createNativeMovementClient({request,correct(payload){if(!disposed)frame.current?.contentWindow?.postMessage(payload,'http://localhost:3021');},status(message){if(!disposed)setStatus(message);}});
  if(['localhost','127.0.0.1'].includes(window.location.hostname))wire=createWorldSocket(token,snapshot=>{
   if(disposed)return;
   client.synchronize(snapshot);
   const state=snapshot as SavedActor&{peers?:Array<{profileId:string;handle:string;cell:{x:number;y:number}}>};
   if(state.peers)sendPeers(state.peers.map(p=>({profileId:p.profileId,handle:p.handle,x:p.cell.x*state.tilePixels,y:p.cell.y*state.tilePixels})));
  },()=>{if(!disposed)sendPeers();});
  const receive=(event:MessageEvent)=>{if(event.origin!=='http://localhost:3021'||!frame.current||event.source!==frame.current.contentWindow)return;void client.observe(event.data);};
  window.addEventListener('message',receive);
  const timer=setInterval(()=>{if(wire?.available()||polling||document.hidden||!frame.current)return;polling=true;void request(undefined,controller.signal).then(snapshot=>{if(!disposed)client.synchronize(snapshot);}).catch(()=>{if(!disposed)sendPeers();}).finally(()=>{polling=false;});},2000);
  return()=>{disposed=true;wire?.dispose();controller.abort();clearInterval(timer);client.dispose();sendPeers();window.removeEventListener('message',receive);};
 },[frame,session,accountId,admission]);
 return accountId&&admission?status:'';
}
