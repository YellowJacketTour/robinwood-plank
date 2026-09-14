"use client";

import Image from 'next/image';
import {useState} from 'react';
import {FAMILY_OPENING,fairyGuidePage,type GuideAction} from '@/lib/charmville/fairy-guide';
import styles from './fairy-guide.module.css';

/** Journal companion. Native follower/healing capability is intentionally not implied. */
export default function FairyGuide({completed,atHome,busy,onAction}:{completed:readonly string[]|null;atHome:boolean;busy:boolean;onAction:(action:GuideAction)=>void}) {
 const [story,setStory]=useState<number|null>(null);
 const guide=fairyGuidePage(completed,atHome);
 const beat=story===null?null:FAMILY_OPENING[story];
 return <section className={styles.guide} aria-label="Your fairy guide">
  <div className={styles.portrait}><Image src="/charmville/items/love-fairy-guide.svg" width={96} height={96} alt="A small golden fairy with leaf-shaped wings"/><span>YOUR GUIDE</span></div>
  <div className={styles.page}>
   <p className={styles.chapter}>{beat?'A GIFT FROM HOME':completed===null?'YOUR JOURNAL':completed.length===0?'A NEW ADVENTURE':'YOUR NEXT CHAPTER'}</p>
   <h3>{beat?beat.speaker:guide.title}</h3>
   <p className={styles.dialogue} aria-live="polite">{beat?.text??guide.text}</p>
   {!beat&&<p className={styles.instruction}>{guide.instruction}</p>}
   <div className={styles.actions}>
    {story===null?<><button type="button" disabled={busy||completed===null} onClick={()=>onAction(guide.action)}>{guide.label}</button><button type="button" className={styles.quiet} onClick={()=>setStory(0)}>Read the opening</button></>:<>
     <button type="button" disabled={story===0} className={styles.quiet} onClick={()=>setStory(value=>Math.max(0,(value??0)-1))}>Back</button>
     <span className={styles.counter} aria-label={`Page ${story+1} of ${FAMILY_OPENING.length}`}>{story+1} / {FAMILY_OPENING.length}</span>
     <button type="button" onClick={()=>setStory(story===FAMILY_OPENING.length-1?null:story+1)}>{story===FAMILY_OPENING.length-1?'My next step':'Next'}</button>
     <button type="button" className={styles.quiet} onClick={()=>setStory(null)}>Close story</button>
    </>}
   </div>
  </div>
 </section>;
}
