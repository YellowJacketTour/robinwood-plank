"use client";
/* eslint-disable @next/next/no-img-element */
import { useState, type ChangeEvent } from "react";
import type { PostMedia } from "./post-media";

export function MediaAttachment({mediaUrl,mediaType,mediaAlt}:{mediaUrl?:string;mediaType?:string;mediaAlt?:string}){
 if(!mediaUrl)return null;
 return <div className="post-media">{mediaType==="video"?<video src={mediaUrl} controls playsInline preload="metadata" aria-label={mediaAlt||"Video attachment"}/>:<img src={mediaUrl} alt={mediaAlt||"Post attachment"}/>}</div>;
}

export function MediaComposer({value,onChange,idPrefix}:{value:PostMedia;onChange:(next:PostMedia)=>void;idPrefix:string}){
 const [open,setOpen]=useState(false);
 const clear=()=>{onChange({mediaUrl:"",mediaType:"",mediaAlt:""});setOpen(false)};
 const pick=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){event.target.value="";return}if(file.size>3_000_000){alert("Images and GIFs must be under 3 MB.");event.target.value="";return}const reader=new FileReader();reader.onload=()=>{onChange({mediaUrl:String(reader.result||""),mediaType:"image",mediaAlt:value.mediaAlt});setOpen(false)};reader.readAsDataURL(file)};
 return <div className={`media-composer-shell ${open?"is-open":""}`}><div className="media-toolbar"><button type="button" className="media-add-toggle" aria-expanded={open} aria-controls={`${idPrefix}-drawer`} onClick={()=>setOpen(current=>!current)}>{open?"× Close":"＋ Add media"}<span aria-hidden="true">▧</span></button><small>Image · GIF · Video</small>{value.mediaUrl&&<div className="media-selected"><span>{value.mediaType==="video"?"Video":"Image / GIF"} attached</span><button type="button" onClick={clear} aria-label="Remove attachment">×</button></div>}</div>{open&&<fieldset id={`${idPrefix}-drawer`} className="media-composer"><legend>Attach media</legend><label htmlFor={`${idPrefix}-file`}>Upload image/GIF<input id={`${idPrefix}-file`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={pick}/></label><span>or</span><label htmlFor={`${idPrefix}-url`}>HTTPS media URL<input id={`${idPrefix}-url`} type="url" value={value.mediaUrl.startsWith("data:")?"":value.mediaUrl} placeholder="https://…" onChange={event=>onChange({...value,mediaUrl:event.target.value,mediaType:value.mediaType||"image"})}/></label><label htmlFor={`${idPrefix}-type`}>Type<select id={`${idPrefix}-type`} value={value.mediaType||"image"} onChange={event=>onChange({...value,mediaType:event.target.value as "image"|"video"})}><option value="image">Image / GIF</option><option value="video">Video</option></select></label><label htmlFor={`${idPrefix}-alt`}>Description<input id={`${idPrefix}-alt`} value={value.mediaAlt} maxLength={180} placeholder="Describe the media" onChange={event=>onChange({...value,mediaAlt:event.target.value})}/></label>{value.mediaUrl&&<MediaAttachment {...value}/>}<div className="media-drawer-actions"><button type="button" onClick={()=>setOpen(false)} disabled={!value.mediaUrl}>Done</button>{value.mediaUrl&&<button type="button" className="media-clear" onClick={clear}>Remove</button>}</div></fieldset>}</div>;
}
