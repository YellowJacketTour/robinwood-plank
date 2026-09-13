"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cropStage, plotCell, projectCell, unprojectPoint, type ScenePlot } from "./isometric";
import styles from "./scene.module.css";
import { sceneryCell, type Decoration } from "../../../../lib/charmville/layout";
import { parseLayoutDraft, type LayoutDraft } from "../../../../lib/charmville/layout-draft";
import { GardenGround, GardenFence, WorkshopSprite } from "./garden-ground";
import { Groundskeeper, type WalkCommand } from "./groundskeeper";
import { nearestWalkable, plotApproach, type GroundPoint } from "@/lib/charmville/navigation";
import { charmvilleAssetFromSource, CHARMVILLE_CONTENT_REVISION } from "@/lib/charmville/content";
import { GameIcon } from "./game-icons";
import { charmPortrait } from "./crop-art";
import cropAtlas from "../../../../public/images/charmville/original/manifest.json";

const ART = "/images/charmville/";
const CROP_SCALE=190/cropAtlas.frameSize[0];
const TERRAIN = Array.from({ length: 81 }, (_, i) => ({x: i % 9, y: Math.floor(i / 9)})).sort((a,b)=>a.x+a.y-b.x-b.y);

export type SceneEffect = { id: string; plotIndex: number; kind: string; qty: number; face?: string };

/** Sprite projections and picking share a ground anchor. Transparent image rectangles never take input. */
export default function YardScene({plots, now, expanded, owner, disabled, onPlot, effect, decorations, layoutRevision, onLayout, draftKey}: {
  draftKey: string | null;
  decorations: Decoration[]; layoutRevision: string; onLayout: (items:Decoration[],revision:string)=>Promise<boolean>;
  plots: ScenePlot[]; now: number; expanded: boolean; owner: boolean; disabled: boolean;
  onPlot: (plot: ScenePlot)=>void; effect: SceneEffect | null;
}) {
  const [savedDraft,setSavedDraft]=useState<(LayoutDraft & {key:string})|null>(null);
  const draft=owner&&draftKey&&savedDraft?.key===draftKey?savedDraft.decorations:null;
  const draftRevision=draft?savedDraft!.revision:"0";
  const conflict=!!draft&&draftRevision!==layoutRevision;
  const [tree,setTree]=useState(0);
  const [layoutNotice,setLayoutNotice]=useState("");
  const [selected,setSelected]=useState(0);
  const [command,setCommand]=useState<WalkCommand|null>(null);
  const [touch,setTouch]=useState<GroundPoint>({x:0,y:0});
  const [actorStatus,setActorStatus]=useState("Ready");
  const actor=useRef<GroundPoint>({x:9,y:5});
  const order=useRef(0);
  const work=useRef<{plotIndex:number;revision:string;target:GroundPoint}|null>(null);
  const [working,setWorking]=useState(false);
  const trees=owner?(draft??decorations):decorations;
  useEffect(()=>{
    if(!owner||!draftKey||savedDraft?.key===draftKey)return;
    try {
      const restored=parseLayoutDraft(localStorage.getItem(draftKey));
      if(restored){
        // Restore client-only draft metadata after verified ownership is available.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSavedDraft({...restored,key:draftKey});
        setLayoutNotice("Scenery draft restored on this device. Save scenery to keep it.");
      }
    }catch{/* Storage denial leaves the in-memory editor usable. */}
  },[owner,draftKey,savedDraft?.key]);
  function keepDraft(items:Decoration[],revision:string){
    if(!owner||!draftKey)return;
    const next:LayoutDraft={version:1,revision,decorations:items};
    setSavedDraft({...next,key:draftKey});
    try{localStorage.setItem(draftKey,JSON.stringify(next));}catch{setLayoutNotice("This browser cannot keep the draft after reload. Keep this tab open until you save scenery.");}
  }
  function clearDraft(key=draftKey){
    if(!key)return;
    try{localStorage.removeItem(key);}catch{/* The current session can still discard its draft. */}
    setSavedDraft(current=>current?.key===key?null:current);
  }
  const beginArrange=()=>{setLayoutNotice("Choose a tree, then choose a marked lawn cell.");keepDraft(decorations.map(item=>({...item})),layoutRevision);};
  function moveTree(x:number,y:number) {
    if(!owner||!draft||disabled)return;
    if(draft.some(item=>item.id!==tree&&item.x===x&&item.y===y)){setLayoutNotice("Another tree is already here.");return;}
    setLayoutNotice("Draft moved. Save scenery to keep it.");keepDraft(draft.map(item=>item.id===tree?{...item,x,y}:item),draftRevision);
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
  const ready=plots.filter(p=>cropStage(p,now)==="ripe");
  const empty=plots.filter(p=>cropStage(p,now)==="empty");
  const nextReady=ready.find(p=>p.plotIndex>selected)??ready[0];
  const stage=active?cropStage(active,now):"empty";
  const minutes=active?.ripeAt?Math.max(0,Math.ceil((Date.parse(active.ripeAt)-now)/60000)):0;
  const stateLabel=stage==="empty"?"Ready to plant":stage==="ripe"?"Ready to gather":stage==="compost"?"Compost - seed returns":`${Math.floor(minutes/60)}h ${minutes%60}m to grow`;
  const canAct=!!active&&!disabled&&(owner?(stage==="empty"||stage==="ripe"||stage==="compost"):(stage==="seedling"||stage==="growing"));
  const objects=[...trees.map(cell=>({type:"tree" as const,cell,index:cell.id})),...plots.map(p=>({type:"plot" as const,cell:plotCell(p.plotIndex),index:p.plotIndex}))].sort((a,b)=>a.cell.x+a.cell.y-b.cell.x-b.cell.y);
  const fx=effect?projectCell(plotCell(effect.plotIndex).x,plotCell(effect.plotIndex).y):null;
  function choosePlot(index:number){
    setSelected(index);work.current=null;setWorking(false);
    if(!draft)setCommand({id:++order.current,target:plotApproach(index,actor.current,trees)});
  }
  function requestWork(){
    if(!active||!canAct||draft)return;
    const target=plotApproach(active.plotIndex,actor.current,trees);
    work.current={plotIndex:active.plotIndex,revision:active.revision,target};setWorking(true);
    setCommand({id:++order.current,target});viewport.current?.focus({preventScroll:true});
  }
  function actorMoved(point:GroundPoint){
    actor.current=point;
    const pending=work.current;if(!pending)return;
    if(disabled||draft){work.current=null;setWorking(false);return;}
    if(Math.hypot(point.x-pending.target.x,point.y-pending.target.y)>.08)return;
    work.current=null;setWorking(false);
    const plot=plots.find(p=>p.plotIndex===pending.plotIndex);
    if(plot&&plot.revision===pending.revision)onPlot(plot);
  }
  function walkToPoint(x:number,y:number){
    if(draft)return;work.current=null;setWorking(false);
    const target=nearestWalkable({x,y},trees);if(target)setCommand({id:++order.current,target});
  }
  return <div ref={frame} data-content-revision={CHARMVILLE_CONTENT_REVISION} className={`${styles.frame} ${visible?styles.playing:""} ${expanded?styles.expanded:""}`}>
    <div className={styles.tools}><span>{ready.length} ripe · {empty.length} open · {plots.length-ready.length-empty.length} resting or growing</span>{owner&&nextReady&&!draft&&<button disabled={disabled} onClick={()=>setSelected(nextReady.plotIndex)}>Find ripe plot</button>}{owner&&!draft&&<button disabled={disabled} aria-label="Arrange scenery" onClick={beginArrange}>Arrange</button>}<button onClick={()=>setZoom(v=>v===1?1.5:1)} aria-label={zoom===1?"Zoom into yard":"Fit yard"}>{zoom===1?"+ Zoom":"Fit yard"}</button></div>
    {owner&&draft&&<div className={styles.tools}><><label>Move tree <select aria-label="Tree to move" value={tree} onChange={e=>setTree(Number(e.target.value))}>{trees.map(item=><option key={item.id} value={item.id}>Tree {item.id+1}</option>)}</select></label><label>Destination<select aria-label="Scenery destination" defaultValue="" disabled={disabled} onChange={e=>{if(e.target.value){const [x,y]=e.target.value.split(",").map(Number);moveTree(x,y);}}}><option value="">Choose lawn cell</option>{TERRAIN.filter(cell=>sceneryCell(cell.x,cell.y)).map(cell=><option key={`${cell.x},${cell.y}`} value={`${cell.x},${cell.y}`}>{cell.x+1}, {cell.y+1}</option>)}</select></label><button disabled={disabled||conflict} onClick={async()=>{const key=draftKey;if(await onLayout(draft,draftRevision)){clearDraft(key);setLayoutNotice("Scenery saved.");}}}>Save scenery</button><button disabled={disabled} onClick={()=>{clearDraft();setLayoutNotice("");}}>Cancel changes</button></></div>}
    {owner&&conflict&&<div className={styles.tools} role="status"><span>Saved scenery changed since this draft began. Your draft is preserved. Reload saved scenery to start from the current layout, or cancel changes.</span><button disabled={disabled} onClick={()=>{setLayoutNotice("Current saved scenery loaded. Choose a tree to arrange.");keepDraft(decorations.map(item=>({...item})),layoutRevision);}}>Reload saved scenery</button></div>}
    {owner&&layoutNotice&&<p role="status" className={styles.tools}>{layoutNotice}</p>}
    <div className={styles.viewport} ref={viewport} tabIndex={0} role="group" aria-label="Garden controls: click to walk, WASD or arrows to move, E to interact" onKeyDown={e=>{if(["w","a","s","d","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)){work.current=null;setWorking(false);}}}>
      <svg className={styles.scene} viewBox="-40 -10 800 510" style={{width:`${zoom*100}%`}} aria-label="Isometric Charmville yard" onClick={e=>{
        if((e.target as Element).closest('[data-plot-hit]')||draft)return;
        const matrix=e.currentTarget.getScreenCTM();if(!matrix)return;
        const screenPoint=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()),ground=unprojectPoint(screenPoint.x,screenPoint.y);
        walkToPoint(ground.x,ground.y);viewport.current?.focus({preventScroll:true});
      }}>
        <title>Your isometric yard. Select a plot, then plant, gather or tend below.</title>
        <g pointerEvents="none">
          <GardenGround/>
          {objects.map(object=>{
            const p=projectCell(object.cell.x,object.cell.y);
            if(object.type==="tree")return <g key={`tree-${object.index}`}><ellipse cx={p.x} cy={p.y+1} rx="18" ry="7" className={styles.treeShadow}/><WorkshopSprite name={object.index%3===1?"blossom-tree":"orchard-tree"} x={object.cell.x} y={object.cell.y} width={object.index%3===1?205:190}/></g>;
            const plot=plots.find(v=>v.plotIndex===object.index)!;
            const state=cropStage(plot,now);
            return <g key={`plot-${plot.plotIndex}`} data-plot={plot.plotIndex} data-stage={state}>
              <image href={charmvilleAssetFromSource(`${ART}original/soil.png`)} x={p.x-cropAtlas.anchor[0]*CROP_SCALE} y={p.y-cropAtlas.anchor[1]*CROP_SCALE} width={cropAtlas.frameSize[0]*CROP_SCALE} height={cropAtlas.frameSize[1]*CROP_SCALE}/>
              {state!=="empty"&&state!=="compost"&&<svg x={p.x-cropAtlas.anchor[0]*CROP_SCALE} y={p.y-cropAtlas.anchor[1]*CROP_SCALE} width={cropAtlas.frameSize[0]*CROP_SCALE} height={cropAtlas.frameSize[1]*CROP_SCALE} viewBox={`0 0 ${cropAtlas.frameSize[0]} ${cropAtlas.frameSize[1]}`} overflow="hidden">
                <image className={styles.cropFrames} style={{animationDelay:`${plot.plotIndex/-cropAtlas.fps}s`,"--frame-count":cropAtlas.frames,"--frame-travel":`${-cropAtlas.frameSize[0]*cropAtlas.frames}px`,"--frame-duration":`${cropAtlas.frames/cropAtlas.fps}s`} as CSSProperties} href={charmvilleAssetFromSource(`${ART}original/${plot.crop==="stalk"?"stalk":"splinter"}-${state}.png`)} width={cropAtlas.frameSize[0]*cropAtlas.frames} height={cropAtlas.frameSize[1]}/>
              </svg>}
              {state==="compost"&&<text x={p.x} y={p.y+5} textAnchor="middle" className={styles.compost}>Seed resting</text>}
              {plot.tended&&<circle cx={p.x+56} cy={p.y-3} r="5" className={styles.care}/>}
              {state==="ripe"&&<g className={styles.ripeMark}><circle cx={p.x} cy={p.y-76} r="12" fill="var(--color-gold-300)"/><path d={`m${p.x-6} ${p.y-76} 4 4 8-9`} fill="none" stroke="var(--color-wood-950)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></g>}
            </g>;
          })}

          <GardenFence/>
          <Groundskeeper command={command} visible={visible} receipt={effect} trees={trees} controls={viewport} touch={touch} onPosition={actorMoved} onInteract={requestWork} onStatus={setActorStatus}/>
        </g>
        {owner&&draft&&TERRAIN.filter(cell=>sceneryCell(cell.x,cell.y)).map(cell=>{const p=projectCell(cell.x,cell.y);return <path key={`place-${cell.x}-${cell.y}`} role="button" tabIndex={0} aria-label={`Place tree at ${cell.x+1}, ${cell.y+1}`} onClick={()=>moveTree(cell.x,cell.y)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();moveTree(cell.x,cell.y);}}} d={`M${p.x} ${p.y-18}l36 18-36 18-36-18Z`} className={styles.placement}/>;})}
        {plots.map(plot=>{const p=projectCell(plotCell(plot.plotIndex).x,plotCell(plot.plotIndex).y);return <g data-plot-hit key={`hit-${plot.plotIndex}`} role="button" tabIndex={0} aria-label={`Select plot ${plot.plotIndex+1}: ${plot.crop??"empty"}, ${cropStage(plot,now)}`} aria-pressed={selected===plot.plotIndex}
          onFocus={()=>setSelected(plot.plotIndex)} onClick={()=>{choosePlot(plot.plotIndex);viewport.current?.focus({preventScroll:true});}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();choosePlot(plot.plotIndex);}}}
          onPointerEnter={()=>setHover(plot.plotIndex)} onPointerLeave={()=>setHover(null)} className={styles.hit}>
          <path d={`M${p.x} ${p.y-31}l65 32.5-65 32.5-65-32.5Z`} className={selected===plot.plotIndex?styles.chosen:hover===plot.plotIndex?styles.hover:styles.outline}/>
          <text x={p.x} y={p.y+27} textAnchor="middle" className={styles.number}>{plot.plotIndex+1}</text>
        </g>;})}
        {effect&&fx&&<g key={effect.id} aria-hidden="true" className={styles.effect} pointerEvents="none" style={{transformOrigin:`${fx.x}px ${fx.y}px`}}>{effect.kind==="harvest"?Array.from({length:Math.min(effect.qty,6)},(_,i)=><image key={i} className={styles.burstFace} style={{"--burst-x":`${(i-(Math.min(effect.qty,6)-1)/2)*28}px`,"--burst-y":`${-16-Math.abs(i-(Math.min(effect.qty,6)-1)/2)*12}px`} as CSSProperties} href={charmPortrait(effect.face??"stalk")} x={fx.x-14} y={fx.y-45} width="28" height="32"/>):<image href={charmPortrait(effect.face??"stalk")} x={fx.x-16} y={fx.y-50} width="32" height="36"/>}<text x={fx.x} y={fx.y-57} textAnchor="middle">{effect.kind==="harvest"?`+${effect.qty} faces` :effect.kind==="plant"?"Planted":effect.kind==="tend"?"Tended":"Seed returned"}</text></g>}
      </svg>
    </div>
    <div className={styles.selection}><div><strong>Plot {selected+1} {active?.crop?` / ${active.crop}`:""}</strong><span>{working?"Walking over to help…":stateLabel}</span></div><button className={styles.actionButton} disabled={!canAct||!!draft||working} onClick={requestWork}><GameIcon kind={owner?(stage==="empty"?"plant":"gather"):"tend"}/>{owner?(stage==="empty"?"Plant here":stage==="compost"?"Compost":stage==="ripe"?"Gather":"Growing"):"Tend"}</button></div>
    <div className={styles.controlsHelp}><span><GameIcon kind="walk"/>{actorStatus} · Click to walk · WASD / arrows · E or controller A to work</span><div className={styles.touchPad} aria-label="Touch movement">{[{name:"up",x:0,y:-1},{name:"left",x:-1,y:0},{name:"down",x:0,y:1},{name:"right",x:1,y:0}].map(d=><button key={d.name} aria-label={`Walk ${d.name}`} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);viewport.current?.focus({preventScroll:true});work.current=null;setWorking(false);setTouch({x:d.x,y:d.y});}} onPointerUp={()=>setTouch({x:0,y:0})} onPointerCancel={()=>setTouch({x:0,y:0})} onLostPointerCapture={()=>setTouch({x:0,y:0})}>{d.name==="up"?"↑":d.name==="left"?"←":d.name==="down"?"↓":"→"}</button>)}</div></div>
    <div className={styles.plotChoices} aria-label="Choose a plot">{plots.map(p=><button key={p.plotIndex} aria-pressed={selected===p.plotIndex} onClick={()=>choosePlot(p.plotIndex)} aria-label={`Choose plot ${p.plotIndex+1}`}>{p.plotIndex+1}</button>)}</div>
    <a className={styles.credits} href={`${ART}CREDITS.html`} target="_blank" rel="noreferrer">Art credits</a>
  </div>;
}
