"use client";
import {useEffect,type RefObject} from 'react';
import {createNativeContactObserver} from '@/lib/charmville/native-contact-observer';
/** Diagnostic transport endpoint; does not call reward or saved garden APIs. */
export function useNativeContactObserver(frame:RefObject<HTMLIFrameElement|null>){
 useEffect(()=>{
  const observe=createNativeContactObserver();
  const receive=(event:MessageEvent)=>{
   if(event.origin!=='http://localhost:3021'||!frame.current||event.source!==frame.current.contentWindow)return;
   const observed=observe(event.data);if(!observed)return;
   window.dispatchEvent(new CustomEvent('charmville:local-contact-observed',{detail:observed}));
  };
  window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
 },[frame]);
}
