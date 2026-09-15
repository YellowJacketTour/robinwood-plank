"use client";

import {useId} from 'react';
import styles from './fairy-portrait.module.css';
import type {FairySkin} from '@/lib/charmville/fairy-presentation';

/** Original orb/wing presentation. No extracted Nintendo textures or healing authority. */
export default function FairyPortrait({skin='blue',attention=false}:{skin?:FairySkin;attention?:boolean}) {
 const id=useId().replaceAll(':','');
 return <svg className={styles.fairy} data-skin={skin} data-attention={attention} viewBox="0 0 96 96" role="img" aria-label="A luminous fairy with four fluttering wings">
  <defs>
   <radialGradient id={`${id}-aura`}><stop offset="0" stopColor="var(--fairy-aura)" stopOpacity=".85"/><stop offset=".45" stopColor="var(--fairy-aura)" stopOpacity=".45"/><stop offset="1" stopColor="var(--fairy-aura)" stopOpacity="0"/></radialGradient>
   <radialGradient id={`${id}-core`} cx="40%" cy="35%"><stop offset="0" stopColor="var(--fairy-core)"/><stop offset=".64" stopColor="var(--fairy-core)"/><stop offset="1" stopColor="var(--fairy-aura)"/></radialGradient>
   <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--fairy-core)"/><stop offset="1" stopColor="var(--fairy-wing)" stopOpacity=".75"/></linearGradient>
  </defs>
  <g className={styles.hover}>
   <circle className={styles.aura} cx="48" cy="52" r="30" fill={`url(#${id}-aura)`}/>
   <g fill={`url(#${id}-wing)`} stroke="var(--fairy-core)" strokeWidth=".8">
    <path className={styles.upperLeft} d="M43 49C31 43 14 28 18 15c1-4 5-4 9 0 10 9 16 23 16 34Z"/>
    <path className={styles.upperRight} d="M53 49c12-6 29-21 25-34-1-4-5-4-9 0-10 9-16 23-16 34Z"/>
    <path className={styles.lowerLeft} d="M42 54C28 56 19 68 23 75c6 8 20-6 21-18Z"/>
    <path className={styles.lowerRight} d="M54 54c14 2 23 14 19 21-6 8-20-6-21-18Z"/>
   </g>
   <circle className={styles.core} cx="48" cy="52" r="14" fill={`url(#${id}-core)`}/>
   <circle cx="44" cy="48" r="4" fill="var(--fairy-core)" opacity=".85"/>
  </g>
 </svg>;
}
