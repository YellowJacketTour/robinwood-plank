"use client";
/* eslint-disable @next/next/no-img-element */
import type { ChangeEvent } from "react";
import type { PostMedia } from "./post-media";

export function MediaAttachment({mediaUrl,mediaType,mediaAlt}:{mediaUrl?:string;mediaType?:string;mediaAlt?:string}){
 if(!mediaUrl)return null;
 return <div className="post-media">{mediaType==="video"?<video src={mediaUrl} controls playsInline preload="metadata" aria-label={mediaAlt||"Video attachment"}/>:<img src={mediaUrl} alt={mediaAlt||"Post attachment"}/>}</div>;
}

export function MediaComposer({value,onChange,idPrefix}:{value:PostMedia;onChange:(next:PostMedia)=>void;idPrefix:string}){
 const pick=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)){event.target.value="";return}if(file.size>3_000_000){alert("Images and GIFs must be under 3 MB.");event.target.value="";return}const reader=new FileReader();reader.onload=()=>onChange({mediaUrl:String(reader.result||""),mediaType:"image",mediaAlt:value.mediaAlt});reader.readAsDataURL(file)};
 return <fieldset className="media-composer"><legend>Add an image, GIF, or video</legend><label htmlFor={`${idPrefix}-file`}>Upload image/GIF<input id={`${idPrefix}-file`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={pick}/></label><span>or</span><label htmlFor={`${idPrefix}-url`}>HTTPS media URL<input id={`${idPrefix}-url`} type="url" value={value.mediaUrl.startsWith("data:")?"":value.mediaUrl} placeholder="https://…" onChange={event=>onChange({...value,mediaUrl:event.target.value,mediaType:value.mediaType||"image"})}/></label><label htmlFor={`${idPrefix}-type`}>Type<select id={`${idPrefix}-type`} value={value.mediaType||"image"} onChange={event=>onChange({...value,mediaType:event.target.value as "image"|"video"})}><option value="image">Image / GIF</option><option value="video">Video</option></select></label><label htmlFor={`${idPrefix}-alt`}>Description<input id={`${idPrefix}-alt`} value={value.mediaAlt} maxLength={180} placeholder="Describe the media" onChange={event=>onChange({...value,mediaAlt:event.target.value})}/></label>{value.mediaUrl&&<><MediaAttachment {...value}/><button type="button" className="media-clear" onClick={()=>onChange({mediaUrl:"",mediaType:"",mediaAlt:""})}>Remove attachment</button></>}</fieldset>;
}
