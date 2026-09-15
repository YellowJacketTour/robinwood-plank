"use client";
import {NATIVE_RUNTIME_ORIGIN as DEFAULT_RUNTIME_ORIGIN} from './native-runtime';
import {useEffect,useState,type RefObject} from 'react';
import {createNativeResourceClient} from '@/lib/charmville/native-resource-client';
export function useNativeResources(frame:RefObject<HTMLIFrameElement|null>,session:RefObject<{token:string}|null>,accountId:string|undefined,admission:string|undefined,onChanged:()=>void,runtimeOrigin=DEFAULT_RUNTIME_ORIGIN){
 const [status,setStatus]=useState('');
 useEffect(()=>{
  const token=session.current?.token;if(!runtimeOrigin||!token||!accountId||!admission)return;
  const abort=new AbortController();let disposed=false,nativeProtocol:2|undefined;
  const request=async(path:string,body?:object)=>{
   const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{}),...(path==='/api/charmville/world/resources'&&nativeProtocol===2?{'X-Charmville-Resource-Protocol':'2','X-Charmville-Resource-Crops':'oran-berry,burning-heart'}:{})},body:body?JSON.stringify(body):undefined,signal:abort.signal,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'The shared world is unavailable.');return data;
  };
  const client=createNativeResourceClient({read:()=>request('/api/charmville/world/resources'),actor:()=>request('/api/charmville/world/actor'),post:body=>request('/api/charmville/world/resources',body),send:body=>{if(!disposed)frame.current?.contentWindow?.postMessage(body,runtimeOrigin);},changed:onChanged,status:message=>{if(!disposed)setStatus(message);},uuid:()=>crypto.randomUUID(),protocolVersion:()=>nativeProtocol});
  const receive=(e:MessageEvent)=>{if(e.origin!==runtimeOrigin||!frame.current||e.source!==frame.current.contentWindow)return;
   const d=e.data;if(d?.type==='charmville:resource-capabilities'){
    if(typeof d.sessionId!=='string'||!/^[a-f0-9-]{36}$/i.test(d.sessionId))return;
    nativeProtocol=d.protocolVersion===2&&Array.isArray(d.crops)&&d.crops.join(',')==='oran-berry,burning-heart'?2:undefined;return;
   }void client.observe(d);};
  const element=frame.current,reset=()=>{nativeProtocol=undefined;};element?.addEventListener('load',reset);
  window.addEventListener('message',receive);const timer=setInterval(()=>{if(!document.hidden&&frame.current)void client.poll();},1000);
  return()=>{disposed=true;clearInterval(timer);client.dispose();abort.abort();element?.contentWindow?.postMessage({type:'charmville:resource-state',active:false,beds:[],seeds:0,produce:0},runtimeOrigin);window.removeEventListener('message',receive);element?.removeEventListener('load',reset);};
 },[frame,session,accountId,admission,onChanged,runtimeOrigin]);
 return accountId&&admission?status:'';
}
