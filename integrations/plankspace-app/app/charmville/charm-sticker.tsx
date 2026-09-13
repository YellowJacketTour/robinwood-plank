"use client";

import { useId } from "react";
import styles from "./charm-sticker.module.css";

/** Original vector expressions. Presentation never grants or changes a charm balance. */
export function CharmSticker({ face, celebratory = false }: { face: string; celebratory?: boolean }) {
  const id = useId().replaceAll(":", "");
  const gold = `url(#${id}-gold)`, wood = `url(#${id}-wood)`, leaf = `url(#${id}-leaf)`;
  const kind = ["stalk", "splinter", "knock", "hum", "pith", "gleam", "knot"].includes(face) ? face : "stalk";
  const shape = kind === "stalk" ? <>
    <path d="M49 92V29" fill="none" strokeWidth="6" />
    <path d="M49 81Q17 80 17 56Q41 54 49 81M51 88Q81 84 84 61Q60 62 51 88" fill={leaf}/>
    {[0, 1, 2].map(n => <g key={n} transform={`translate(0 ${n * 15})`}><path d="M49 45Q23 42 28 23Q49 23 49 45M51 45Q77 42 72 23Q51 23 51 45" fill={gold}/></g>)}
    <path d="M50 31Q34 14 50 7Q67 15 50 31" fill={gold}/>
  </> : kind === "splinter" ? <>
    <path d="m29 17 20 4 13-10 14 9-7 76-19-9-19 9-10-17Z" fill={wood}/>
    <path d="m29 17 20 4 13-10 14 9-25 10Z" fill={gold}/>
    <path d="m34 34-5 42m34-44-6 44m-15 1-2 10" stroke="var(--color-wood-600)" fill="none" strokeWidth="2"/>
  </> : kind === "knock" ? <>
    <path d="m46 46-7 47q9 8 19-1l-1-48" fill={wood}/>
    <path d="M15 23q29-14 67-1l2 34q-36 10-68-2Z" fill={gold}/>
    <path d="m23 22 2 32m47-33 1 35" fill="none" stroke="var(--color-wood-600)" strokeWidth="2"/>
  </> : kind === "hum" ? <>
    <path d="m69 22 9-15M35 26v-9q15-10 30 0v9" fill="none" strokeWidth="5"/>
    <rect x="15" y="24" width="70" height="64" rx="16" fill="var(--color-forest-600)"/>
    <rect x="22" y="32" width="56" height="45" rx="11" fill={gold}/>
    <path d="M30 83h8m25 0h8" stroke="var(--color-gold-300)"/>
    <path d="M20 47h7m-7 7h7m-7 7h7m46-14h7m-7 7h7m-7 7h7" strokeWidth="2"/>
  </> : kind === "pith" ? <>
    <path d="M50 23Q38 5 27 17Q33 32 50 23" fill={leaf}/>
    <path d="M49 27q-2-12 9-16" fill="none" strokeWidth="4"/>
    <path d="M49 26C3 15 9 78 36 89q15 6 29-1C96 71 88 16 49 26Z" fill={gold}/>
    <path d="M23 43q-6 15 0 26" fill="none" stroke="var(--color-cream)" strokeWidth="5" opacity=".7"/>
  </> : kind === "gleam" ? <>
    <path d="M77 29Q57 5 32 21C3 44 18 87 48 90q32 3 36-22-7 12-26 4C35 62 38 29 56 29q11-1 13 9l-10 8q27-1 18-17Z" fill={gold}/>
    <path d="M32 27Q13 52 35 77" fill="none" stroke="var(--color-cream)" strokeWidth="5" opacity=".8"/>
  </> : <>
    <path d="M50 15C7 9 8 47 15 69q11 32 47 22 32-6 27-44-3-33-39-32Z" fill={wood}/>
    <path d="M50 23C18 17 17 48 23 67q7 23 35 17 27-3 24-35-2-26-32-26Z" fill={gold} strokeWidth="2"/>
    <path d="M48 31C28 29 25 48 31 67q7 12 22 10 23-3 22-24-2-23-27-22Z" fill="none" stroke="var(--color-wood-600)" strokeWidth="2"/>
  </>;
  return <svg viewBox="0 0 100 112" className={`${styles.sticker} ${celebratory ? styles.celebrate : ""}`} data-charm-sticker={kind} aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-gold`} x2=".3" y2="1"><stop stopColor="var(--color-cream)"/><stop offset=".35" stopColor="var(--color-gold-300)"/><stop offset="1" stopColor="var(--color-gold-600)"/></linearGradient>
      <linearGradient id={`${id}-wood`} x2="1" y2=".7"><stop stopColor="var(--color-gold-300)"/><stop offset=".5" stopColor="var(--color-wood-600)"/><stop offset="1" stopColor="var(--color-wood-700)"/></linearGradient>
      <linearGradient id={`${id}-leaf`} x2=".7" y2="1"><stop stopColor="var(--color-gold-300)"/><stop offset="1" stopColor="var(--color-forest-600)"/></linearGradient>
      <filter id={`${id}-edge`} x="-30%" y="-25%" width="160%" height="165%" colorInterpolationFilters="sRGB"><feMorphology in="SourceAlpha" operator="dilate" radius="2.6" result="edge"/><feFlood floodColor="var(--color-cream)"/><feComposite in2="edge" operator="in" result="paper"/><feDropShadow in="paper" dx="0" dy="3" stdDeviation="1.5" floodColor="var(--color-wood-950)" floodOpacity=".28"/><feMerge><feMergeNode/><feMergeNode in="paper"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <g className={styles.body} filter={`url(#${id}-edge)`} stroke="var(--color-wood-900)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round">
      {shape}
      <g transform={kind === "gleam" ? "translate(-10 4)" : kind === "knock" ? "translate(0 -11)" : ""}>
        <ellipse cx="37" cy="57" rx="3.6" ry="5" fill="var(--color-wood-950)" stroke="none"/>
        {kind === "splinter" ? <path d="m59 53 7 4-7 2" fill="none"/> : <ellipse cx="63" cy="57" rx="3.6" ry="5" fill="var(--color-wood-950)" stroke="none"/>}
        <circle cx="36" cy="55" r="1.2" fill="var(--color-cream)" stroke="none"/><circle cx="62" cy="55" r="1.2" fill="var(--color-cream)" stroke="none"/>
        <path d={kind === "hum" ? "M43 68q7-7 14 0" : "M43 65q7 9 14 0"} fill="none" strokeWidth="2.2"/>
        <ellipse cx="29" cy="66" rx="4" ry="2" fill="var(--color-gold-400)" stroke="none"/><ellipse cx="71" cy="66" rx="4" ry="2" fill="var(--color-gold-400)" stroke="none"/>
      </g>
    </g>
    <g className={styles.sparkle} fill="var(--color-cream)" stroke="var(--color-gold-600)" strokeWidth="1"><path d="m85 10 2.5 7.5L95 20l-7.5 2.5L85 30l-2.5-7.5L75 20l7.5-2.5Z"/><path d="m15 81 1.5 4.5L21 87l-4.5 1.5L15 93l-1.5-4.5L9 87l4.5-1.5Z"/></g>
  </svg>;
}
