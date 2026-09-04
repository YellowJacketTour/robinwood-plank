"use client";
import {useEffect,useMemo,useRef} from "react";

const CONSENT_KEY="plankspace-terms-2026-08-22-v1";
const idFrom=(raw:string)=>{try{const u=new URL(raw),host=u.hostname.replace(/^www\./,"");return host==="youtu.be"?u.pathname.slice(1).split("/")[0]:(host==="youtube.com"||host==="m.youtube.com"||host==="youtube-nocookie.com")?(u.searchParams.get("v")||u.pathname.split("/")[2]):""}catch{return ""}};

export default function ProfileVideoPlayer({links,title}:{links:string;title:string}){
 const frame=useRef<HTMLIFrameElement>(null),ids=useMemo(()=>links.split(/[\s,]+/).map(idFrom).filter(id=>/^[\w-]{6,20}$/.test(id)).slice(0,8),[links]);
 const src=ids.length?`https://www.youtube-nocookie.com/embed/${ids[0]}?autoplay=1&mute=0&playsinline=1&rel=0&enablejsapi=1${ids.length>1?`&playlist=${ids.slice(1).join(",")}`:""}`:"";
 useEffect(()=>{if(!src)return;const play=()=>frame.current?.contentWindow?.postMessage(JSON.stringify({event:"command",func:"playVideo",args:[]}),"*");const accepted=()=>{play();setTimeout(play,250);setTimeout(play,1000)};window.addEventListener("plankspace:terms-accepted",accepted);if(localStorage.getItem(CONSENT_KEY)==="accepted"&&sessionStorage.getItem("plankspace-audio-unlocked")==="1")setTimeout(accepted,400);return()=>window.removeEventListener("plankspace:terms-accepted",accepted)},[src]);
 if(!src)return <p className="public-empty">No featured video yet.</p>;
 return <div className="video-frame"><iframe ref={frame} src={src} title={title} loading="eager" sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen/></div>;
}
