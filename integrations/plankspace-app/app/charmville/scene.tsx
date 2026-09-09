"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cropStage, plotCell, projectCell, type ScenePlot } from "./isometric";
import styles from "./scene.module.css";
import { sceneryCell, type Decoration } from "../../../../lib/charmville/layout";
import cropAtlas from "../../../../public/images/charmville/original/manifest.json";

const ART = "/images/charmville/";
const CROP_SCALE=190/cropAtlas.frameSize[0];
const TERRAIN = Array.from({ length: 81 }, (_, i) => ({x: i % 9, y: Math.floor(i / 9)})).sort((a,b)=>a.x+a.y-b.x-b.y);

export type SceneEffect = { id: string; plotIndex: number; kind: string; qty: number };

/** Sprite projections and picking share a ground anchor. Transparent image rectangles never take input. */
export default function YardScene({plots, now, expanded, owner, disabled, onPlot, effect, decorations, layoutRevision, onLayout}: {
  decorations: Decoration[]; layoutRevision: string; onLayout: (items:Decoration[],revision:string)=>Promise<boolean>;
  plots: ScenePlot[]; now: number; expanded: boolean; owner: boolean; disabled: boolean;
  onPlot: (plot: ScenePlot)=>void; effect: SceneEffect | null;
}) {
  const [draft,setDraft]=useState<Decoration[]|null>(null);
  const [draftRevision,setDraftRevision]=useState("0");
  const [tree,setTree]=useState(0);
  const [layoutNotice,setLayoutNotice]=useState("");
  const [selected,setSelected]=useState(0);
  const trees=draft??decorations;
  function moveTree(x:number,y:number) {
    if(!draft||disabled)return;
    if(draft.some(item=>item.id!==tree&&item.x===x&&item.y===y)){setLayoutNotice("Another tree is already here.");return;}
    setDraft(draft.map(item=>item.id===tree?{...item,x,y}:item));setLayoutNotice("Draft moved. Save scenery to keep it.");
  }
  const [zoom,setZoom]=useState(1);
  const [visible,setVisible]=useState(false);
  const [hover,setHover]=useState<number|null>(null);
  const frame=useRef<HTMLDivElement>(null);
  const viewport=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const element=frame.current;if(!element)return;
    let intersects=false;
    const update=()=>setVisible(intersects&&document.visibilityState==="visible");
    const observer=new IntersectionObserver(entries=>{intersects=entries[0].isIntersecting;update();});
    observer.observe(element);document.addEventListener("visibilitychange",update);
    const scroll=viewport.current;
    const resize=new ResizeObserver(()=>{if(scroll)scroll.scrollLeft=(scroll.scrollWidth-scroll.clientWidth)/2;});
    if(scroll)resize.observe(scroll);
    return()=>{resize.disconnect();observer.disconnect();document.removeEventListener("visibilitychange",update);};
  },[]);
  const active=plots.find(p=>p.plotIndex===selected)??plots[0];
  const stage=active?cropStage(active,now):"empty";
  const minutes=active?.ripeAt?Math.max(0,Math.ceil((Date.parse(active.ripeAt)-now)/60000)):0;
  const stateLabel=stage==="empty"?"Ready to plant":stage==="ripe"?"Ready to gather":stage==="compost"?"Compost - seed returns":`${Math.floor(minutes/60)}h ${minutes%60}m to grow`;
  const canAct=!!active&&!disabled&&(owner?(stage==="empty"||stage==="ripe"||stage==="compost"):(stage==="seedling"||stage==="growing"));
  const objects=[...trees.map(cell=>({type:"tree" as const,cell,index:cell.id})),...plots.map(p=>({type:"plot" as const,cell:plotCell(p.plotIndex),index:p.plotIndex}))].sort((a,b)=>a.cell.x+a.cell.y-b.cell.x-b.cell.y);
  const fx=effect?projectCell(plotCell(effect.plotIndex).x,plotCell(effect.plotIndex).y):null;
  return <div ref={frame} className={`${styles.frame} ${visible?styles.playing:""} ${expanded?styles.expanded:""}`}>
    <div className={styles.tools}><span>Six plots. Your corner of the Lumberyard.</span><button onClick={()=>setZoom(v=>v===1?1.5:1)} aria-label={zoom===1?"Zoom into yard":"Fit yard"}>{zoom===1?"+ Zoom":"Fit yard"}</button></div>
    {owner&&<div className={styles.tools}>{draft?<><label>Move tree <select aria-label="Tree to move" value={tree} onChange={e=>setTree(Number(e.target.value))}>{trees.map(item=><option key={item.id} value={item.id}>Tree {item.id+1}</option>)}</select></label><button disabled={disabled} onClick={async()=>{if(await onLayout(draft,draftRevision)){setDraft(null);setLayoutNotice("Scenery saved.");}}}>Save scenery</button><button disabled={disabled} onClick={()=>{setDraft(null);setLayoutNotice("");}}>Cancel changes</button></>:<button disabled={disabled} onClick={()=>{setDraft(decorations.map(item=>({...item})));setDraftRevision(layoutRevision);setLayoutNotice("Choose a tree, then choose a marked lawn cell.");}}>Arrange scenery</button>}</div>}
    {layoutNotice&&<p role="status" className={styles.tools}>{layoutNotice}</p>}
    <div className={styles.viewport} ref={viewport}>
      <svg className={styles.scene} viewBox="0 0 720 470" style={{width:`${zoom*100}%`}} aria-label="Isometric Charmville yard">
        <title>Your isometric yard. Select a plot, then plant, gather or tend below.</title>
        <g pointerEvents="none">
          {TERRAIN.map(cell=>{const p=projectCell(cell.x,cell.y);return <image key={`${cell.x}-${cell.y}`} href={`${ART}grass.png`} x={p.x-40} y={p.y-22} width="80" height="43.75"/>;})}
          {objects.map(object=>{
            const p=projectCell(object.cell.x,object.cell.y);
            if(object.type==="tree")return <image key={`tree-${object.index}`} href={`${ART}${object.index%2?"tree2":"tree"}.png`} x={p.x-40} y={p.y-79} width="80" height="80"/>;
            const plot=plots.find(v=>v.plotIndex===object.index)!;
            const state=cropStage(plot,now);
            return <g key={`plot-${plot.plotIndex}`} data-plot={plot.plotIndex} data-stage={state}>
              <image href={`${ART}soil.png`} x={p.x-72} y={p.y-112} width="144" height="144"/>
              {state!=="empty"&&state!=="compost"&&<svg x={p.x-cropAtlas.anchor[0]*CROP_SCALE} y={p.y-cropAtlas.anchor[1]*CROP_SCALE} width={cropAtlas.frameSize[0]*CROP_SCALE} height={cropAtlas.frameSize[1]*CROP_SCALE} viewBox={`0 0 ${cropAtlas.frameSize[0]} ${cropAtlas.frameSize[1]}`} overflow="hidden">
                <image className={styles.cropFrames} style={{animationDelay:`${plot.plotIndex/-cropAtlas.fps}s`,"--frame-count":cropAtlas.frames,"--frame-travel":`${-cropAtlas.frameSize[0]*cropAtlas.frames}px`,"--frame-duration":`${cropAtlas.frames/cropAtlas.fps}s`} as CSSProperties} href={`${ART}original/${plot.crop==="stalk"?"stalk":"splinter"}-${state}.png`} width={cropAtlas.frameSize[0]*cropAtlas.frames} height={cropAtlas.frameSize[1]}/>
              </svg>}
              {state==="compost"&&<text x={p.x} y={p.y+5} textAnchor="middle" className={styles.compost}>Seed resting</text>}
              {plot.tended&&<circle cx={p.x+56} cy={p.y-3} r="5" className={styles.care}/>}
              {state==="ripe"&&<g className={styles.ripeMark}><image href="/images/plank-head.webp" x={p.x-12} y={p.y-89} width="24" height="27"/></g>}
            </g>;
          })}

        </g>
        {draft&&TERRAIN.filter(cell=>sceneryCell(cell.x,cell.y)).map(cell=>{const p=projectCell(cell.x,cell.y);return <path key={`place-${cell.x}-${cell.y}`} role="button" tabIndex={0} aria-label={`Place tree at ${cell.x+1}, ${cell.y+1}`} onClick={()=>moveTree(cell.x,cell.y)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();moveTree(cell.x,cell.y);}}} d={`M${p.x} ${p.y-18}l36 18-36 18-36-18Z`} className={styles.placement}/>;})}
        {plots.map(plot=>{const p=projectCell(plotCell(plot.plotIndex).x,plotCell(plot.plotIndex).y);return <g key={`hit-${plot.plotIndex}`} role="button" tabIndex={0} aria-label={`Select plot ${plot.plotIndex+1}: ${plot.crop??"empty"}, ${cropStage(plot,now)}`} aria-pressed={selected===plot.plotIndex}
          onFocus={()=>setSelected(plot.plotIndex)} onClick={()=>setSelected(plot.plotIndex)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelected(plot.plotIndex);}}}
          onPointerEnter={()=>setHover(plot.plotIndex)} onPointerLeave={()=>setHover(null)} className={styles.hit}>
          <path d={`M${p.x} ${p.y-31}l65 32.5-65 32.5-65-32.5Z`} className={selected===plot.plotIndex?styles.chosen:hover===plot.plotIndex?styles.hover:styles.outline}/>
          <text x={p.x} y={p.y+27} textAnchor="middle" className={styles.number}>{plot.plotIndex+1}</text>
        </g>;})}
        {effect&&fx&&<g key={effect.id} className={styles.effect} pointerEvents="none" style={{transformOrigin:`${fx.x}px ${fx.y}px`}}><image href="/images/plank-head.webp" x={fx.x-16} y={fx.y-50} width="32" height="36"/><text x={fx.x} y={fx.y-57} textAnchor="middle">{effect.kind==="harvest"?`+${effect.qty} faces` :effect.kind==="plant"?"Planted":effect.kind==="tend"?"Tended":"Seed returned"}</text></g>}
      </svg>
    </div>
    <div className={styles.selection}><div><strong>Plot {selected+1} {active?.crop?` / ${active.crop}`:""}</strong><span>{stateLabel}</span></div><button disabled={!canAct||!!draft} onClick={()=>active&&onPlot(active)}>{owner?(stage==="empty"?"Plant here":stage==="compost"?"Compost":stage==="ripe"?"Gather":"Growing"):"Tend"}</button></div>
    <div className={styles.plotChoices} aria-label="Choose a plot">{plots.map(p=><button key={p.plotIndex} aria-pressed={selected===p.plotIndex} onClick={()=>setSelected(p.plotIndex)} aria-label={`Choose plot ${p.plotIndex+1}`}>{p.plotIndex+1}</button>)}</div>
    <a className={styles.credits} href={`${ART}CREDITS.html`} target="_blank" rel="noreferrer">Art credits</a>
  </div>;
}
