"use client";
import { ChangeEvent, useState } from "react";
import { connectPlankLoveWallet } from "./plank-love-wallet";
import { walletProof } from "./auth-client";
import type { PostMedia } from "./post-media";

export function MediaAttachment({mediaUrl,mediaType,mediaAlt}:{mediaUrl?:string;mediaType?:string;mediaAlt?:string}){
 if(!mediaUrl)return null;
 if(mediaType==="link")return <p className="post-media-link"><a href={mediaUrl} target="_blank" rel="noreferrer">🔗 {mediaAlt||mediaUrl}</a></p>;
 if(mediaType==="gift"){const icon:Record<string,string>={"gift:plank":"🪵","gift:heart":"❤️","gift:fire":"🔥","gift:diamond":"💎","gift:tree":"🌲"};return <div className="post-media-gift" role="img" aria-label={mediaAlt||"PlankSpace gift"}><span>{icon[mediaUrl]||"🎁"}</span><b>{mediaAlt||"A PlankSpace gift"}</b></div>}
 return <div className="post-media">{mediaType==="video"?<video src={mediaUrl} controls playsInline preload="metadata" aria-label={mediaAlt||"Video attachment"}/>:<img src={mediaUrl} alt={mediaAlt||"Post attachment"}/>}</div>;
}

export function MediaComposer({value,onChange,idPrefix}:{value:PostMedia;onChange:(value:PostMedia)=>void;idPrefix:string}){
 const [open,setOpen]=useState(false),[uploading,setUploading]=useState(false),[error,setError]=useState("");
 const clear=()=>{onChange({mediaUrl:"",mediaType:"",mediaAlt:""});setOpen(false);setError("")};
 const pick=async(event:ChangeEvent<HTMLInputElement>)=>{
  const file=event.target.files?.[0];if(!file)return;setError("");
  const isVideo=/^video\/(mp4|webm)$/.test(file.type),isImage=/^image\/(png|jpeg|webp|gif)$/.test(file.type);
  if(!isVideo&&!isImage){setError("Use PNG, JPEG, WebP, GIF, MP4, or WebM media.");event.target.value="";return}
  if((isVideo&&file.size>20_000_000)||(!isVideo&&file.size>3_000_000)){setError(isVideo?"Videos must be under 20 MB.":"Images and GIFs must be under 3 MB.");event.target.value="";return}
  setUploading(true);
  try{
   const wallet=await connectPlankLoveWallet(),proof=await walletProof(wallet,"media:upload","plankspace",{}),form=new FormData();
   form.set("file",file);form.set("wallet",proof.wallet||wallet);form.set("sessionToken",proof.sessionToken||"");
   const response=await fetch("/api/plankspace-media",{method:"POST",body:form}),result=await response.json();
   if(!response.ok||!result.upload?.url)throw new Error(result.error||"Upload failed.");
   onChange({mediaUrl:result.upload.url,mediaType:result.upload.mediaType,mediaAlt:value.mediaAlt});
  }catch(e){setError(e instanceof Error?e.message:"Upload failed.")}finally{setUploading(false);event.target.value=""}
 };
 return <div className={`media-composer-shell ${open?"is-open":""}`}><div className="media-toolbar"><button type="button" className="media-add-toggle" aria-expanded={open} aria-controls={`${idPrefix}-drawer`} onClick={()=>setOpen(current=>!current)}>{open?"× Close":"＋ Add media"}<span aria-hidden="true">▧</span></button><small>Gift · Picture · GIF · Video · Website</small>{value.mediaUrl&&<div className="media-selected"><span>{value.mediaType==="video"?"Video":value.mediaType==="link"?"Website":value.mediaType==="gift"?"Gift":"Image / GIF"} attached</span><button type="button" onClick={clear} aria-label="Remove attachment">×</button></div>}</div>{open&&<fieldset id={`${idPrefix}-drawer`} className="media-composer"><legend>Attach media</legend><div className="media-gifts" aria-label="Send a gift"><button type="button" onClick={()=>onChange({mediaUrl:"gift:plank",mediaType:"gift",mediaAlt:"A Plank for you"})}>🪵 Plank</button><button type="button" onClick={()=>onChange({mediaUrl:"gift:heart",mediaType:"gift",mediaAlt:"Heart"})}>❤️ Heart</button><button type="button" onClick={()=>onChange({mediaUrl:"gift:fire",mediaType:"gift",mediaAlt:"Fire"})}>🔥 Fire</button><button type="button" onClick={()=>onChange({mediaUrl:"gift:diamond",mediaType:"gift",mediaAlt:"Diamond"})}>💎 Diamond</button><button type="button" onClick={()=>onChange({mediaUrl:"gift:tree",mediaType:"gift",mediaAlt:"Tree"})}>🌲 Tree</button></div><label htmlFor={`${idPrefix}-file`}>Upload picture, GIF, or video<input id={`${idPrefix}-file`} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" onChange={pick} disabled={uploading}/></label>{uploading&&<small role="status">Uploading to Plank.love…</small>}<span>or</span><label htmlFor={`${idPrefix}-url`}>HTTPS URL<input id={`${idPrefix}-url`} type="url" value={value.mediaUrl.startsWith("/api/media/")?"":value.mediaUrl} placeholder="https://…" onChange={event=>onChange({...value,mediaUrl:event.target.value,mediaType:value.mediaType||"image"})}/></label><label htmlFor={`${idPrefix}-type`}>Type<select id={`${idPrefix}-type`} value={value.mediaType||"image"} onChange={event=>onChange({...value,mediaType:event.target.value as PostMedia["mediaType"]})}><option value="image">Image / GIF</option><option value="video">Video</option><option value="link">Website link</option><option value="gift">Gift</option></select></label><label htmlFor={`${idPrefix}-alt`}>Description<input id={`${idPrefix}-alt`} value={value.mediaAlt} maxLength={180} placeholder={value.mediaType==="link"?"Website title":"Describe the media"} onChange={event=>onChange({...value,mediaAlt:event.target.value})}/></label>{error&&<small role="alert">{error}</small>}{value.mediaUrl&&<MediaAttachment {...value}/>}<div className="media-drawer-actions"><button type="button" onClick={()=>setOpen(false)} disabled={!value.mediaUrl||uploading}>Done</button>{value.mediaUrl&&<button type="button" className="media-clear" onClick={clear}>Remove</button>}</div></fieldset>}</div>;
}
