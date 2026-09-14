"use client";

import {useEffect,useRef,useState} from 'react';
import {FAMILY_OPENING,fairyGuidePage,type GuideAction} from '@/lib/charmville/fairy-guide';
import {parseStoryBookmark,storyBookmarkKey,type StoryBookmark} from '@/lib/charmville/story-bookmark';
import styles from './fairy-guide.module.css';
import FairyPortrait from './fairy-portrait';
import {FAIRY_SKINS,isFairySkin,type FairySkin} from '@/lib/charmville/fairy-presentation';

/** Journal companion. Native follower/healing capability is intentionally not implied. */
export default function FairyGuide({profileId,completed,atHome,busy,onAction}:{profileId:string;completed:readonly string[]|null;atHome:boolean;busy:boolean;onAction:(action:GuideAction)=>void}) {
 const [story,setStory]=useState<number|null>(null);
 const [skinState,setSkin]=useState<{profileId:string;skin:FairySkin}>({profileId,skin:'blue'});
 const skin=skinState.profileId===profileId?skinState.skin:'blue';
 const [saved,setSaved]=useState<{profileId:string;bookmark:StoryBookmark|null}|null>(null);
 const bookmark=saved?.profileId===profileId?saved.bookmark:null;
 const nextButton=useRef<HTMLButtonElement>(null),readButton=useRef<HTMLButtonElement>(null),wasReading=useRef(false);
 useEffect(()=>{
  const key=storyBookmarkKey(profileId);
  const read=()=>{let value:StoryBookmark|null=null;let look:FairySkin='blue';try{value=key?parseStoryBookmark(localStorage.getItem(key)):null;const stored=key?localStorage.getItem(`${key}:look`):null;if(isFairySkin(stored))look=stored;}catch{/* Storage may be unavailable in private browsing. */}setSaved({profileId,bookmark:value});setSkin({profileId,skin:look});};
  read();const change=(event:StorageEvent)=>{if(event.key===key||event.key===`${key}:look`)read();};
  window.addEventListener('storage',change);return()=>window.removeEventListener('storage',change);
 },[profileId]);
 useEffect(()=>{
  if(story!==null){wasReading.current=true;nextButton.current?.focus({preventScroll:true});}
  else if(wasReading.current){wasReading.current=false;readButton.current?.focus({preventScroll:true});}
 },[story]);
 const remember=(page:number,finished=false)=>{
  const value:StoryBookmark={version:1,page,finished};setSaved({profileId,bookmark:value});
  const key=storyBookmarkKey(profileId);try{if(key)localStorage.setItem(key,JSON.stringify(value));}catch{/* Reading works without browser storage. */}
 };
 const turn=(page:number)=>{remember(page);setStory(page);};
 const advance=()=>{if(story===null)return;if(story===FAMILY_OPENING.length-1){remember(0,true);setStory(null);}else turn(story+1);};
 const chooseSkin=(id:FairySkin)=>{
  setSkin({profileId,skin:id});const key=storyBookmarkKey(profileId);
  try{if(key)localStorage.setItem(`${key}:look`,id);}catch{/* The selected color remains usable for this visit. */}
 };
 const guide=fairyGuidePage(completed,atHome);
 const beat=story===null?null:FAMILY_OPENING[story];
 return <section className={styles.guide} aria-label="Your fairy guide" onKeyDown={event=>{
  if(story===null||event.altKey||event.ctrlKey||event.metaKey||event.repeat)return;
  const key=event.key.toLowerCase();
  if(['a','arrowright','b','escape','arrowleft'].includes(key)){
   event.preventDefault();event.stopPropagation();
   if(key==='a'||key==='arrowright')advance();
   else if(key==='arrowleft'){if(story>0)turn(story-1);}
   else setStory(null);
  }
 }}>
  <div className={styles.portrait}><FairyPortrait skin={skin} attention={story!==null}/><span>YOUR GUIDE</span><details className={styles.look}><summary>Look</summary><div role="group" aria-label="Guide color">{FAIRY_SKINS.map(([id,label])=><button key={id} type="button" aria-pressed={skin===id} onClick={()=>chooseSkin(id)}>{label}</button>)}</div><small>On this browser</small></details></div>
  <div className={styles.page}>
   <p className={styles.chapter}>{beat?'A GIFT FROM HOME':completed===null?'YOUR JOURNAL':completed.length===0?'A NEW ADVENTURE':'YOUR NEXT CHAPTER'}</p>
   <h3>{beat?beat.speaker:guide.title}</h3>
   <p className={styles.dialogue} aria-live="polite">{beat?.text??guide.text}</p>
   {!beat&&<p className={styles.instruction}>{guide.instruction}</p>}
   <div className={styles.actions}>
    {story===null?<><button type="button" disabled={busy||completed===null} onClick={()=>onAction(guide.action)}>{guide.label}</button><button ref={readButton} type="button" className={styles.quiet} onClick={()=>turn(bookmark&&!bookmark.finished?bookmark.page:0)}>{bookmark?.finished?'Read the opening again':bookmark&&bookmark.page>0?'Continue the opening':'Read the opening'}</button></>:<>
     <button type="button" disabled={story===0} className={styles.quiet} onClick={()=>turn(Math.max(0,story-1))}>Back</button>
     <span className={styles.counter} aria-label={`Page ${story+1} of ${FAMILY_OPENING.length}`}>{story+1} / {FAMILY_OPENING.length}</span>
     <button ref={nextButton} type="button" onClick={advance}>{story===FAMILY_OPENING.length-1?'My next step':'Next'}</button>
     <button type="button" className={styles.quiet} onClick={()=>setStory(null)}>Close story</button>
    </>}
   </div>
   {story!==null&&<p className={styles.readingHelp}>A / → Next · B / Esc Close · ← Back<br/>Reading place saved on this browser. Your adventure stays unchanged.</p>}
  </div>
 </section>;
}
