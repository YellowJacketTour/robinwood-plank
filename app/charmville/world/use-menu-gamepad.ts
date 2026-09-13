"use client";
import {useEffect,type RefObject} from 'react';
/** Parent menus only. The native frame owns its own gamepad while it has focus. */
export function useMenuGamepad(root:RefObject<HTMLElement|null>,enabled:boolean,onBack:()=>void,contextKey?:string){
 useEffect(()=>{
  if(!enabled)return;
  let frame=0,neutral=true,previous=new Set<number>(),context:Element|null=null;
  const suspend=()=>{neutral=true;previous.clear();};
  const poll=()=>{
   const scope=root.current,focused=document.activeElement;
   const active=!!scope&&document.hasFocus()&&!document.hidden&&focused?.tagName!=='IFRAME'&&document.fullscreenElement?.tagName!=='IFRAME';
   const pad=Array.from(navigator.getGamepads?.()??[]).find(p=>p?.connected&&p.mapping==='standard');
   const pressed=new Set<number>();if(pad){pad.buttons.forEach((b,i)=>{if(b.pressed)pressed.add(i);});if((pad.axes[1]??0)<-.35)pressed.add(12);if((pad.axes[1]??0)>.35)pressed.add(13);if((pad.axes[0]??0)<-.35)pressed.add(14);if((pad.axes[0]??0)>.35)pressed.add(15);}
   const modal=Array.from(scope?.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"]')??[]).find(element=>element.getClientRects().length>0&&!element.closest('[hidden],[inert]'))??scope;
   if(modal!==context){context=modal??null;neutral=true;}
   if(!active||!pad)neutral=true;
   else if(!pressed.size)neutral=false;
   const typing=focused instanceof HTMLElement&&(focused.isContentEditable||['INPUT','TEXTAREA'].includes(focused.tagName));
   if(active&&pad&&!neutral&&!typing&&scope&&modal){
    const edge=(i:number)=>pressed.has(i)&&!previous.has(i);
    const controls=Array.from(modal.querySelectorAll<HTMLElement>('button,summary,a[href],input,select,textarea,[tabindex]')).filter(e=>e.tabIndex>=0&&!e.matches(':disabled,[aria-disabled="true"]')&&e.getClientRects().length>0&&!e.closest('[hidden],[inert]'));
    const current=focused instanceof HTMLElement&&modal.contains(focused)?focused:null;
    if(edge(1))onBack();
    else if(edge(0)){if(current&&controls.includes(current))current.click();else controls[0]?.focus();}
    else{const direction=[12,13,14,15].find(edge);if(direction!==undefined){
     const key={12:'ArrowUp',13:'ArrowDown',14:'ArrowLeft',15:'ArrowRight'}[direction]!;
     const navigation=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
     if(current)current.dispatchEvent(navigation);
     if(navigation.defaultPrevented){/* The focused roving control handled navigation. */}
     else if(current instanceof HTMLSelectElement&&(direction===14||direction===15)){
      const delta=direction===14?-1:1;let next=current.selectedIndex+delta;while(next>=0&&next<current.options.length&&current.options[next].disabled)next+=delta;
      if(next>=0&&next<current.options.length){current.selectedIndex=next;current.dispatchEvent(new Event('change',{bubbles:true}));}
     }else{const delta=direction===12||direction===14?-1:1,index=current?controls.indexOf(current):-1;controls[index<0?0:(index+delta+controls.length)%controls.length]?.focus();}
    }}
   }
   previous=pressed;frame=requestAnimationFrame(poll);
  };
  window.addEventListener('blur',suspend);window.addEventListener('gamepaddisconnected',suspend);document.addEventListener('visibilitychange',suspend);frame=requestAnimationFrame(poll);
  return()=>{cancelAnimationFrame(frame);window.removeEventListener('blur',suspend);window.removeEventListener('gamepaddisconnected',suspend);document.removeEventListener('visibilitychange',suspend);};
 },[root,enabled,onBack,contextKey]);
}
