"use client";
import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from "react";

type Room={slug:string;title:string;jitsiRoom:string};
type JitsiApi={dispose:()=>void;executeCommand:(command:string,...args:unknown[])=>void;addListener:(event:string,handler:(payload:unknown)=>void)=>void};
declare global{interface Window{JitsiMeetExternalAPI?:new(domain:string,options:Record<string,unknown>)=>JitsiApi}}
type LiveContext={room:Room|null;muted:boolean;expanded:boolean;join:(room:Room,displayName:string,role:string)=>void;leave:()=>void;toggleMute:()=>void;setExpanded:(value:boolean)=>void};
const Context=createContext<LiveContext|null>(null);
const domain=process.env.NEXT_PUBLIC_JITSI_DOMAIN||"meet.jit.si";

function loadJitsi(){return new Promise<void>((resolve,reject)=>{if(window.JitsiMeetExternalAPI)return resolve();const existing=document.querySelector<HTMLScriptElement>("script[data-plankspace-jitsi]");if(existing){existing.addEventListener("load",()=>resolve(),{once:true});return}const script=document.createElement("script");script.src=`https://${domain}/external_api.js`;script.async=true;script.dataset.plankspaceJitsi="true";script.onload=()=>resolve();script.onerror=()=>reject(new Error("Woodstock audio could not load."));document.head.appendChild(script)})}

export function WoodstockLiveProvider({children}:{children:React.ReactNode}){
 const [room,setRoom]=useState<Room|null>(null),[identity,setIdentity]=useState({displayName:"PlankSpace Listener",role:"listener"}),[muted,setMuted]=useState(true),[expanded,setExpanded]=useState(false),[error,setError]=useState("");
 const mount=useRef<HTMLDivElement>(null),api=useRef<JitsiApi|null>(null);
 const leave=useCallback(()=>{api.current?.dispose();api.current=null;setRoom(null);setExpanded(false);setMuted(true);setError("")},[]);
 const join=useCallback((next:Room,displayName:string,role:string)=>{setIdentity({displayName,role});setRoom(next);setExpanded(true)},[]);
 useEffect(()=>{if(!room||!mount.current)return;let cancelled=false;void loadJitsi().then(()=>{if(cancelled||!mount.current||!window.JitsiMeetExternalAPI)return;api.current?.dispose();api.current=new window.JitsiMeetExternalAPI(domain,{roomName:room.jitsiRoom,parentNode:mount.current,userInfo:{displayName:identity.displayName},width:"100%",height:"100%",configOverwrite:{startWithAudioMuted:identity.role==="listener",startWithVideoMuted:true,prejoinConfig:{enabled:false},disableDeepLinking:true,toolbarButtons:["microphone","hangup","settings","audioonly"]},interfaceConfigOverwrite:{VIDEO_LAYOUT_FIT:"nocrop",MOBILE_APP_PROMO:false,SHOW_JITSI_WATERMARK:false}});api.current.addListener("videoConferenceLeft",leave);setMuted(identity.role==="listener")}).catch(cause=>setError(cause instanceof Error?cause.message:"Woodstock audio failed"));return()=>{cancelled=true}},[identity,leave,room]);
 const toggleMute=useCallback(()=>{api.current?.executeCommand("toggleAudio");setMuted(value=>!value)},[]);
 const value=useMemo(()=>({room,muted,expanded,join,leave,toggleMute,setExpanded}),[room,muted,expanded,join,leave,toggleMute]);
 return <Context.Provider value={value}>{children}{room&&<aside className={`woodstock-mini ${expanded?"expanded":""}`} aria-label="Woodstock persistent audio player"><div className="woodstock-mini-bar"><button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>🪵 LIVE</button><a href={`/woodstock/${room.slug}`}>{room.title}</a><button onClick={toggleMute}>{muted?"Unmute":"Mute"}</button><button onClick={leave}>Leave</button></div><div className="woodstock-jitsi" ref={mount}/>{error&&<p role="alert">{error}</p>}</aside>}</Context.Provider>;
}
export function useWoodstockLive(){const value=useContext(Context);if(!value)throw new Error("Woodstock provider missing");return value}
