"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { projectCell } from "./isometric";
import { facingForScreenVector, findGroundPath, moveAlongGround, nearestWalkable, type GroundPoint } from "@/lib/charmville/navigation";
import type { Decoration } from "@/lib/charmville/layout";
import { charmvilleAssetFromSource } from "@/lib/charmville/content";

export type WalkCommand = { id: number; target: GroundPoint };
type Pose=GroundPoint & {direction:number;frame:number;action:"idle"|"walk"|"pickup"};

/** Inputs move one presentation actor; economic actions remain server-authorized. */
export function Groundskeeper({command,visible,receipt,trees,controls,touch,onPosition,onInteract,onStatus}:{
  command:WalkCommand|null;visible:boolean;receipt?:{id:string;kind:string}|null;trees:Decoration[];
  controls:RefObject<HTMLDivElement|null>;touch:GroundPoint;
  onPosition:(point:GroundPoint)=>void;onInteract:()=>void;onStatus:(status:string)=>void;
}) {
  const position=useRef<GroundPoint>({x:9,y:5});
  const path=useRef<GroundPoint[]>([]),keys=useRef(new Set<string>()),lastCommand=useRef(-1),lastReceipt=useRef("");
  const latest=useRef({trees,touch,onPosition,onInteract,onStatus,command,receipt});
  useEffect(()=>{latest.current={trees,touch,onPosition,onInteract,onStatus,command,receipt};},[trees,touch,onPosition,onInteract,onStatus,command,receipt]);
  const [pose,setPose]=useState<Pose>({x:9,y:5,direction:1,frame:0,action:"idle"});
  useEffect(()=>{
    if(!visible)return;
    const heldKeys=keys.current;
    let animation=0,previous=performance.now(),painted=0,walkTime=0,pickupUntil=0,lastA=false,lastStatus="",direction=1;
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)");
    const active=()=>!!controls.current?.contains(document.activeElement);
    const keydown=(event:KeyboardEvent)=>{
      if(!active()||event.ctrlKey||event.metaKey||event.altKey)return;
      if((event.target as HTMLElement).matches("input,select,textarea"))return;
      const key=event.key.toLowerCase();
      if(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"].includes(key)){event.preventDefault();keys.current.add(key);}
      if((key==="e"||key===" ")&&!event.repeat){event.preventDefault();latest.current.onInteract();}
    };
    const keyup=(event:KeyboardEvent)=>keys.current.delete(event.key.toLowerCase());
    const blur=()=>{keys.current.clear();path.current=[];};
    window.addEventListener("keydown",keydown);window.addEventListener("keyup",keyup);window.addEventListener("blur",blur);
    const status=(value:string)=>{if(lastStatus!==value){lastStatus=value;latest.current.onStatus(value);}};
    const tick=(time:number)=>{
      const elapsed=Math.min((time-previous)/1000,.05);previous=time;
      const state=latest.current;
      if(state.command&&state.command.id!==lastCommand.current){
        lastCommand.current=state.command.id;path.current=findGroundPath(position.current,state.command.target,state.trees);
        status(path.current.length?"On my way":"Ready");
      }
      if(state.receipt&&state.receipt.id!==lastReceipt.current){
        lastReceipt.current=state.receipt.id;
        if(["harvest","plant","tend","compost"].includes(state.receipt.kind))pickupUntil=time+750;
      }
      let sx=state.touch.x,sy=state.touch.y;
      if(active()){
        sx+=(keys.current.has("d")||keys.current.has("arrowright")?1:0)-(keys.current.has("a")||keys.current.has("arrowleft")?1:0);
        sy+=(keys.current.has("s")||keys.current.has("arrowdown")?1:0)-(keys.current.has("w")||keys.current.has("arrowup")?1:0);
        const pad=Array.from(navigator.getGamepads?.()??[]).find(p=>p?.connected);
        if(pad){
          sx+=Math.abs(pad.axes[0]??0)>.18?pad.axes[0]:0;sy+=Math.abs(pad.axes[1]??0)>.18?pad.axes[1]:0;
          sx+=(pad.buttons[15]?.pressed?1:0)-(pad.buttons[14]?.pressed?1:0);sy+=(pad.buttons[13]?.pressed?1:0)-(pad.buttons[12]?.pressed?1:0);
          const a=pad.buttons[0]?.pressed??false;if(a&&!lastA)state.onInteract();lastA=a;
        }else lastA=false;
      }else{keys.current.clear();lastA=false;}
      const before=position.current;
      if(Math.hypot(sx,sy)>.1){
        path.current=[];position.current=moveAlongGround(before,sx,sy,elapsed,state.trees);direction=facingForScreenVector(sx,sy);
      }else if(path.current.length){
        const next=path.current[0],dx=next.x-before.x,dy=next.y-before.y,distance=Math.hypot(dx,dy),step=elapsed*2.5;
        if(distance<=step){position.current=next;path.current.shift();}
        else position.current={x:before.x+dx/distance*step,y:before.y+dy/distance*step};
        direction=facingForScreenVector((dx-dy)*40,(dx+dy)*20);
      }
      const moving=Math.hypot(position.current.x-before.x,position.current.y-before.y)>.0001;
      if(moving){walkTime+=elapsed;status("Walking");}else if(!path.current.length)status(time<pickupUntil?"A little care":"Ready");
      const action:Pose["action"]=moving?"walk":time<pickupUntil&&!reduced.matches?"pickup":"idle";
      if(time-painted>45){
        painted=time;const frame=reduced.matches?0:action==="walk"?Math.floor(walkTime*10)%8:action==="pickup"?Math.min(7,Math.floor((time-(pickupUntil-750))/94)):0;
        const next={...position.current,direction,frame,action};
        setPose(current=>current.x===next.x&&current.y===next.y&&current.direction===next.direction&&current.frame===next.frame&&current.action===next.action?current:next);
        state.onPosition(position.current);
      }
      animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(animation);heldKeys.clear();window.removeEventListener("keydown",keydown);window.removeEventListener("keyup",keyup);window.removeEventListener("blur",blur);};
  },[visible,controls]);
  useEffect(()=>{
    const safe=nearestWalkable(position.current,trees);path.current=[];
    if(safe&&Math.hypot(position.current.x-safe.x,position.current.y-safe.y)>.7)position.current=safe;
  },[trees]);
  const p=projectCell(pose.x,pose.y);
  return <g aria-label="Your groundskeeper" pointerEvents="none" data-groundskeeper data-x={pose.x.toFixed(3)} data-y={pose.y.toFixed(3)} data-direction={pose.direction} data-moving={pose.action==="walk"} data-action={pose.action}>
    <ellipse cx={p.x} cy={p.y+1} rx="11" ry="4" fill="var(--color-wood-950)" opacity=".28"/>
    <svg x={p.x-40} y={p.y-90} width="80" height="100" viewBox="0 0 128 160" overflow="hidden">
      <image href={charmvilleAssetFromSource(`/images/charmville/quaternius-farmer/atlases/${pose.action}-${pose.direction}.webp`)} x={-pose.frame*128} y="0" width={pose.action==="idle"?128:1024} height="160"/>
    </svg>
  </g>;
}
