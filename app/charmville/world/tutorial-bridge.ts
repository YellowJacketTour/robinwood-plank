"use client";
import {useEffect,useState,type RefObject} from 'react';
/** Presentation preference only: completing the introduction grants no rewards. */
export function useTutorialBridge(frame:RefObject<HTMLIFrameElement|null>,token:string|null){
 const [status,setStatus]=useState('');
 useEffect(()=>{
  if(!token)return;
  const controller=new AbortController(),context=crypto.randomUUID();
  let completed:boolean|undefined,busy=false,lastAttempt=0;
  const send=()=>{if(completed!==undefined)frame.current?.contentWindow?.postMessage({type:'charmville:tutorial-state',context,completed},'http://localhost:3021');};
  const request=async(save=false)=>{
   if(busy||Date.now()-lastAttempt<1000)return;
   busy=true;lastAttempt=Date.now();
   try{
    const response=await fetch('/api/charmville/tutorial',{method:save?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(save?{'Content-Type':'application/json'}:{})},body:save?JSON.stringify({completed:true}):undefined,cache:'no-store',credentials:'same-origin',mode:'same-origin',redirect:'error',signal:controller.signal});
    if(!response.ok)throw Error('Tutorial preference unavailable');
    const result=await response.json();if(typeof result.completed!=='boolean')throw Error('Invalid tutorial preference');
    if(!controller.signal.aborted){completed=result.completed;setStatus('');send();}
   }catch{if(!controller.signal.aborted)setStatus(save?'Opening instructions could not be saved yet. Retrying…':'Checking saved opening instructions…');}
   finally{busy=false;}
  };
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.current?.contentWindow||event.origin!=='http://localhost:3021')return;
   if(event.data?.type==='charmville:tutorial-ready'){if(completed===undefined)void request();else send();}
   if(event.data?.type==='charmville:tutorial-completed'&&event.data.context===context&&!completed)void request(true);
  };
  window.addEventListener('message',receive);void request();
  return()=>{controller.abort();window.removeEventListener('message',receive);};
 },[frame,token]);
 return token?status:'';
}
