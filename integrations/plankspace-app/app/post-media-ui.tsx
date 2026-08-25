"use client";
/* eslint-disable @next/next/no-img-element */
import { useState, type ChangeEvent } from "react";
import type { PostMedia } from "./post-media";

const gifts=["🎁","💝","🪵","🍊","🌲","🔥","🍻","🪙"];

function linkLabel(mediaUrl:string,mediaAlt?:string){
 if(mediaAlt)return mediaAlt;
 try{return new URL(mediaUrl).hostname.replace(/^www\./,"")}catch{return "Open attached link"}
}

export function MediaAttachment({mediaUrl,mediaType,mediaAlt}:{mediaUrl?:string;mediaType?:string;mediaAlt?:string}){
 if(!mediaUrl)return null;
 if(mediaType==="gift")return <div className="post-media post-gift" role="img" aria-label={mediaAlt||"A PlankSpace gift"}><span>{mediaUrl.replace(/^gift:/,"")}</span>{mediaAlt&&<small>{mediaAlt}</small>}</div>;
 if(mediaType==="link")return <a className="post-media post-link" href={mediaUrl} target="_blank" rel="noreferrer"><span>↗</span><div><small>SHARED LINK</small><b>{linkLabel(mediaUrl,mediaAlt)}</b><code>{mediaUrl}</code></div></a>;
 return <div className="post-media">{mediaType==="video"?<video src={mediaUrl} controls playsInline preload="metadata" aria-label={mediaAlt||"Video attachment"}/>:<img src={mediaUrl} alt={mediaAlt||"Post attachment"}/>}</div>;
}

export function MediaComposer({value,onChange,idPrefix}:{value:PostMedia;onChange:(next:PostMedia)=>void;idPrefix:string}){
 const [open,setOpen]=useState(false);
 const clear=()=>{onChange({mediaUrl:"",mediaType:"",mediaAlt:""});setOpen(false)};
 const pick=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){event.target.value="";return}if(file.size>3_000_000){alert("Images and GIFs must be under 3 MB.");event.target.value="";return}const reader=new FileReader();reader.onload=()=>{onChange({mediaUrl:String(reader.result||""),mediaType:"image",mediaAlt:value.mediaAlt});setOpen(false)};reader.readAsDataURL(file)};
 const typeLabel=value.mediaType==="video"?"Video":value.mediaType==="link"?"Link":value.mediaType==="gift"?"Gift":"Image / GIF";
 const urlValue=value.mediaUrl.startsWith("data:")||value.mediaUrl.startsWith("gift:")?"":value.mediaUrl;
 return <div className={`media-composer-shell ${open?"is-open":""}`}><div className="media-toolbar"><button type="button" className="media-add-toggle" aria-expanded={open} aria-controls={`${idPrefix}-drawer`} onClick={()=>setOpen(current=>!current)}>{open?"× Close":"＋ Add media"}<span aria-hidden="true">▧</span></button><small>Gift · Image · GIF · Video · Link</small>{value.mediaUrl&&<div className="media-selected"><span>{typeLabel} attached</span><button type="button" onClick={clear} aria-label="Remove attachment">×</button></div>}</div>{open&&<fieldset id={`${idPrefix}-drawer`} className="media-composer"><legend>Attach media</legend><div className="media-gifts"><b>Send a gift</b><div>{gifts.map(gift=><button type="button" key={gift} aria-label={`Attach ${gift} gift`} onClick={()=>onChange({mediaUrl:`gift:${gift}`,mediaType:"gift",mediaAlt:""})}>{gift}</button>)}</div></div><label htmlFor={`${idPrefix}-file`}>Upload picture or GIF<input id={`${idPrefix}-file`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={pick}/></label><span className="media-or">or add an HTTPS address</span><label htmlFor={`${idPrefix}-url`}>Media or page link<input id={`${idPrefix}-url`} type="url" value={urlValue} placeholder="https://…" onChange={event=>onChange({...value,mediaUrl:event.target.value,mediaType:value.mediaType==="video"||value.mediaType==="link"?value.mediaType:"image"})}/></label><label htmlFor={`${idPrefix}-type`}>Link type<select id={`${idPrefix}-type`} value={value.mediaType==="gift"?"image":value.mediaType||"image"} onChange={event=>onChange({...value,mediaType:event.target.value as "image"|"video"|"link",mediaUrl:value.mediaType==="gift"?"":value.mediaUrl})}><option value="image">Picture / GIF</option><option value="video">Video</option><option value="link">Website link</option></select></label><label htmlFor={`${idPrefix}-alt`}>Description<input id={`${idPrefix}-alt`} value={value.mediaAlt} maxLength={180} placeholder={value.mediaType==="link"?"Optional link title":"Describe the attachment"} onChange={event=>onChange({...value,mediaAlt:event.target.value})}/></label>{value.mediaUrl&&<MediaAttachment {...value}/>}<div className="media-drawer-actions"><button type="button" onClick={()=>setOpen(false)} disabled={!value.mediaUrl}>Done</button>{value.mediaUrl&&<button type="button" className="media-clear" onClick={clear}>Remove</button>}</div></fieldset>}</div>;
}
