"use client";
import {useEffect,useRef,useState} from 'react';
import {nativeMaps} from '@/lib/charmville/native-world';
import {nativeAtlas,atlasPoint} from '@/lib/charmville/native-atlas';
import type {RegionMapState} from './native-movement';
import {pinchMap,wheelZoomFactor} from '@/lib/charmville/map-gesture';

export default function RegionMap({state}:{state:RegionMapState|null}){
 const [zoom,setZoom]=useState(1);
 const [center,setCenter]=useState<{x:number;y:number}|null>(null);
 const drag=useRef<{id:number;x:number;y:number;center:{x:number;y:number}}|null>(null);
 const pointers=useRef(new Map<number,{x:number;y:number}>());
 const pinch=useRef<{distance:number;zoom:number;center:{x:number;y:number};midpoint:{x:number;y:number};scale:number}|null>(null);
 const mapElement=useRef<SVGSVGElement|null>(null);
 // Native non-passive listener is required: React wheel listeners may be passive.
 useEffect(()=>{
  const element=mapElement.current;if(!element)return;
  const wheel=(event:WheelEvent)=>{
   if(event.altKey||event.metaKey)return;
   event.preventDefault();event.stopPropagation();
   const box=element.getBoundingClientRect();const currentWidth=(nativeAtlas.width+2)/zoom,currentHeight=(nativeAtlas.height+2)/zoom;
   const raw=center??{x:nativeAtlas.width/2,y:nativeAtlas.height/2};
   const currentCenter={x:Math.max(-1+currentWidth/2,Math.min(nativeAtlas.width+1-currentWidth/2,raw.x)),y:Math.max(-1+currentHeight/2,Math.min(nativeAtlas.height+1-currentHeight/2,raw.y))};
   const scale=Math.min(box.width/currentWidth,box.height/currentHeight);if(scale<=0)return;
   if(event.shiftKey){const delta=event.deltaX||event.deltaY;const pixels=delta*(event.deltaMode===1?16:event.deltaMode===2?box.width:1);setCenter({...currentCenter,x:currentCenter.x+pixels/scale});return;}
   const midpoint={x:event.clientX-box.left-box.width/2,y:event.clientY-box.top-box.height/2};
   const next=pinchMap({distance:1,zoom,center:currentCenter,midpoint},{distance:wheelZoomFactor(event.deltaY,event.deltaMode,box.height),midpoint},scale);
   if(next){setZoom(next.zoom);setCenter(next.center);}
  };
  element.addEventListener('wheel',wheel,{passive:false});
  return ()=>element.removeEventListener('wheel',wheel);
 });
 if(!state)return null;
 const supported=nativeMaps.some(map=>map.id===state.geometryId&&map.revision===state.geometryRevision);
 const you=supported?atlasPoint(state.geometryId,state.cell):null;
 const area=nativeAtlas.areas.find(area=>area.geometryId===state.geometryId);
 const width=(nativeAtlas.width+2)/zoom,height=(nativeAtlas.height+2)/zoom;
 const clamp=(p:{x:number;y:number})=>({x:Math.max(-1+width/2,Math.min(nativeAtlas.width+1-width/2,p.x)),y:Math.max(-1+height/2,Math.min(nativeAtlas.height+1-height/2,p.y))});
 const view=clamp(center??{x:nativeAtlas.width/2,y:nativeAtlas.height/2});
 const location=state.regionId===`home:${state.profileId}`?'Your homestead':state.regionId.startsWith('home:')?'Visiting a homestead':'Public world';
 const control='min-h-11 rounded-lg border border-line px-3 py-2 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:opacity-50';
 const findMe=()=>{if(you)setCenter({x:you.x+.5,y:you.y+.5});};
 const endPointer=(id:number)=>{pointers.current.delete(id);pinch.current=null;drag.current=null;};
 return <details className="mb-2 rounded-lg border border-line p-2 text-sm">
  <summary className="min-h-11 cursor-pointer py-2">World map · {location} · {area?.label??'Locating…'}</summary>
  {!supported?<p>Map geometry is updating. Position markers are hidden until it matches.</p>:<>
   <div className="mb-2 flex flex-wrap items-center gap-2 text-gold-300" role="group" aria-label="Map controls">
    <button type="button" className={control} disabled={zoom===1} onClick={()=>setZoom(value=>Math.max(1,value/2))} aria-label="Zoom out">−</button>
    <output aria-live="polite">{Number(zoom.toFixed(1))}×</output>
    <button type="button" className={control} disabled={zoom===4} onClick={()=>{findMe();setZoom(value=>Math.min(4,value*2));}} aria-label="Zoom in">+</button>
    <button type="button" className={control} disabled={!you} onClick={findMe}>Find me</button>
    <button type="button" className={control} onClick={()=>{setZoom(1);setCenter(null);}}>Whole map</button>
   </div>
   <svg ref={mapElement} viewBox={`${view.x-width/2} ${view.y-height/2} ${width} ${height}`} tabIndex={0} role="img" aria-label="World map. Arrows or WASD pan, plus and minus zoom, Home locates you, zero shows the whole map." onKeyDown={event=>{
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    const key=event.key.toLowerCase();
    const moves:Record<string,{x:number;y:number}>={ArrowLeft:{x:-width/8,y:0},ArrowRight:{x:width/8,y:0},ArrowUp:{x:0,y:-height/8},ArrowDown:{x:0,y:height/8}};
    const aliases:Record<string,string>={w:'ArrowUp',a:'ArrowLeft',s:'ArrowDown',d:'ArrowRight'};
    const move=moves[aliases[key]??event.key];
    if(!move&&!['Home','+','=','-','_','0','PageUp','PageDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Home'){findMe();return;}
    if(event.key==='0'){setZoom(1);setCenter(null);return;}
    if(['+','=','PageUp'].includes(event.key)){setZoom(v=>Math.min(4,v*1.25));return;}
    if(['-','_','PageDown'].includes(event.key)){setZoom(v=>Math.max(1,v/1.25));return;}
    if(move){const speed=event.shiftKey?2:1;setCenter(clamp({x:view.x+move.x*speed,y:view.y+move.y*speed}));}
   }} onPointerDown={event=>{
    if(event.button!==0||pointers.current.size>=2)return;event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.current.size===1)drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,center:view};
    else {const [a,b]=[...pointers.current.values()];const box=event.currentTarget.getBoundingClientRect();pinch.current={distance:Math.hypot(b.x-a.x,b.y-a.y),zoom,center:view,midpoint:{x:(a.x+b.x)/2-box.left-box.width/2,y:(a.y+b.y)/2-box.top-box.height/2},scale:Math.min(box.width/width,box.height/height)};drag.current=null;}
   }}
   onPointerMove={event=>{
    if(!pointers.current.has(event.pointerId))return;pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const box=event.currentTarget.getBoundingClientRect();
    if(pinch.current&&pointers.current.size===2){const [a,b]=[...pointers.current.values()];const next=pinchMap(pinch.current,{distance:Math.hypot(b.x-a.x,b.y-a.y),midpoint:{x:(a.x+b.x)/2-box.left-box.width/2,y:(a.y+b.y)/2-box.top-box.height/2}},pinch.current.scale);if(next){setZoom(next.zoom);setCenter(next.center);}return;}
    const start=drag.current;if(!start||start.id!==event.pointerId)return;const scale=Math.min(box.width/width,box.height/height);if(scale>0)setCenter(clamp({x:start.center.x-(event.clientX-start.x)/scale,y:start.center.y-(event.clientY-start.y)/scale}));
   }}
   onPointerUp={event=>endPointer(event.pointerId)} onPointerCancel={event=>endPointer(event.pointerId)} onLostPointerCapture={event=>endPointer(event.pointerId)}
   style={{display:'block',width:'100%',maxWidth:640,aspectRatio:`${nativeAtlas.width+2} / ${nativeAtlas.height+2}`,touchAction:'none',cursor:zoom>1?'grab':'default',background:'var(--color-wood-950)',border:'2px solid var(--color-line)',imageRendering:'pixelated'}}>
    {nativeAtlas.areas.map(area=>{const geometry=nativeMaps.find(map=>map.id===area.geometryId);return <g key={area.geometryId} transform={`translate(${area.x} ${area.y})`}>
     <title>{area.label}</title>
     {geometry?.blocked.map(key=>{const [x,y]=key.split(',').map(Number);return <rect key={key} x={x} y={y} width={1} height={1} fill="var(--color-forest-700)"/>;})}
     <rect width={area.width} height={area.height} fill="none" stroke={state.geometryId===area.geometryId?'var(--color-gold-500)':'var(--color-line)'} strokeWidth={.2}/>
    </g>;})}
    <path d="M 31 5 H 33 M 31 12 H 33" fill="none" stroke="var(--color-gold-300)" strokeWidth={.4}><title>Connected walking border</title></path>
    {(state.peers??[]).filter(peer=>peer.profileId!==state.profileId).map(peer=>{const point=atlasPoint(state.geometryId,peer.cell);return point?<circle key={peer.profileId} cx={point.x+.5} cy={point.y+.5} r={.55} fill="var(--color-cream)"><title>{peer.handle}</title></circle>:null;})}
    {you&&<path d={`M ${you.x+.5} ${you.y-.3} l .8 1.4 h -1.6 Z`} fill="var(--color-gold-500)"><title>Your server-confirmed position</title></path>}
   </svg>
   <p className="mt-2 text-xs text-cream-muted">▲ You · ● Nearby players · Gold border: your area. Walk west from the meadow to reach the connected path.</p>
   <p className="mt-1 text-xs text-cream-muted">Wheel or pinch: zoom · Drag or arrows/WASD: pan · Shift + wheel: pan sideways · +/− or Page Up/Down: zoom · Home: find me · 0: whole map. Keyboard controls apply while the map is focused. Players outside your current area are not shown.</p>
  </>}
 </details>;
}
