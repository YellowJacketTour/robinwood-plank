"use client";
import {useEffect,useState,type RefObject} from 'react';
import {createNativeResourceClient} from '@/lib/charmville/native-resource-client';
export function useNativeResources(frame:RefObject<HTMLIFrameElement|null>,session:RefObject<{token:string}|null>,accountId:string|undefined,admission:string|undefined,onChanged:()=>void){
 const [status,setStatus]=useState('');
 useEffect(()=>{
  const token=session.current?.token;if(!token||!accountId||!admission)return;
  const abort=new AbortController();let disposed=false;
  const request=async(path:string,body?:object)=>{
   const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:abort.signal,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error'});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'The shared world is unavailable.');return data;
  };
  const client=createNativeResourceClient({read:()=>request('/api/charmville/world/resources'),actor:()=>request('/api/charmville/world/actor'),post:body=>request('/api/charmville/world/resources',body),send:body=>{if(!disposed)frame.current?.contentWindow?.postMessage(body,'http://localhost:3021');},changed:onChanged,status:message=>{if(!disposed)setStatus(message);},uuid:()=>crypto.randomUUID()});
  const receive=(e:MessageEvent)=>{if(e.origin!=='http://localhost:3021'||!frame.current||e.source!==frame.current.contentWindow)return;void client.observe(e.data);};
  window.addEventListener('message',receive);const timer=setInterval(()=>{if(!document.hidden&&frame.current)void client.poll();},1000);
  return()=>{disposed=true;clearInterval(timer);client.dispose();abort.abort();frame.current?.contentWindow?.postMessage({type:'charmville:resource-state',active:false,beds:[],seeds:0,produce:0},'http://localhost:3021');window.removeEventListener('message',receive);};
 },[frame,session,accountId,admission,onChanged]);
 return accountId&&admission?status:'';
}
