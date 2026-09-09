import { useId } from "react";

/** Authored SVG enamel tool badges; sharp at every display scale. */
export function GameIcon({kind}:{kind:"walk"|"plant"|"gather"|"arrange"|"tend"|"expand"|"satchel"}){
  const id=useId().replaceAll(":","");
  return <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <defs><linearGradient id={id} x2=".3" y2="1"><stop stopColor="var(--charm-honey)"/><stop offset="1" stopColor="var(--color-wood-600)"/></linearGradient></defs>
    <g stroke="var(--color-wood-700)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
      {kind==="walk"&&<><ellipse cx="30" cy="40" rx="11" ry="16" transform="rotate(22 30 40)" fill={`url(#${id})`}/>{[[24,17,5],[36,14,5],[46,20,4],[49,29,3]].map(([x,y,r])=><circle key={x} cx={x} cy={y} r={r} fill={`url(#${id})`}/>)}</>}
      {(kind==="plant"||kind==="tend")&&<><ellipse cx="32" cy="53" rx="20" ry="6" fill={`url(#${id})`}/><path d="M32 51V25M31 37Q11 41 9 16Q32 16 32 35M33 29Q33 8 55 9Q55 30 33 29" fill="var(--charm-sage)"/><path d="m15 22 16 14m17-20-15 12" fill="none" stroke="var(--charm-leaf)"/>{kind==="tend"&&<path d="M53 37q-10 11 0 13 10-2 0-13Z" fill="var(--charm-sky)"/>}</>}
      {kind==="gather"&&<><path d="M14 30q0-24 18-24t18 24" fill="none" strokeWidth="5"/><path d="m8 28 7 26h34l7-26Z" fill={`url(#${id})`}/><path d="m20 31 3 19m9-19v19m12-19-3 19M13 39h38M15 47h34" stroke="var(--charm-honey)"/>{[[22,26],[34,23],[43,29]].map(([x,y])=><circle key={x} cx={x} cy={y} r="8" fill={x===34?"var(--charm-peach)":"var(--charm-sage)"}/>)}</>}
      {kind==="arrange"&&<><path d="M12 54V13l6-7 6 7v41m17 0V13l6-7 6 7v41" fill={`url(#${id})`}/><path d="M6 22h52v8H6Zm0 19h52v8H6Z" fill="var(--charm-honey)"/><path d="M29 51q-5-15 6-17 7 10-6 17" fill="var(--charm-sage)"/></>}
      {kind==="expand"&&<g fill="none" strokeWidth="5"><path d="M23 10H10v13m31-13h13v13M10 41v13h13m31-13v13H41M12 12l13 13m27-13L39 25M12 52l13-13m27 13L39 39"/></g>}
      {kind==="satchel"&&<><path d="M12 19q20-9 40 0l3 33q-23 9-46 0Z" fill={`url(#${id})`}/><path d="M23 15V9h19v6M10 22q22 15 44 0v12q-22 13-44 0Z" fill="var(--charm-honey)"/><rect x="28" y="31" width="10" height="14" rx="4" fill="var(--color-gold-500)"/></>}
    </g>
  </svg>;
}
