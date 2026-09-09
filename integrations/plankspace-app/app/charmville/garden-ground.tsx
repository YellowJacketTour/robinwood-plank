"use client";

import { memo, useId } from "react";
import { projectCell } from "./isometric";
import cropAtlas from "../../../../public/images/charmville/original/manifest.json";
import { charmvilleAssetFromSource } from "@/lib/charmville/content";

const ART="/images/charmville/kenney/";

export function WorkshopSprite({name,x,y,width=200}:{name:string;x:number;y:number;width?:number}){
  const p=projectCell(x,y);
  return <image href={charmvilleAssetFromSource(`/images/charmville/workshop/${name}@3x.png`)} x={p.x-width/2} y={p.y-width*132.444/256} width={width} height={width*.75}/>;
}

// Kenney's miniature sprites share a 256x512 canvas and ground centre 128,448.
export function FarmSprite({name,x,y,width=80,lift=0}:{name:string;x:number;y:number;width?:number;lift?:number}) {
  const p=projectCell(x,y),scale=width/256;
  if(name==="planks_N") {
    const boardScale=104/cropAtlas.frameSize[0];
    return <image href="/images/charmville/original/boardwalk.png" x={p.x-cropAtlas.anchor[0]*boardScale} y={p.y-cropAtlas.anchor[1]*boardScale} width={104} height={cropAtlas.frameSize[1]*boardScale}/>;
  }
  return <image href={`${ART}${name}.png`} x={p.x-width/2} y={p.y-448*scale-lift} width={width} height={width*2}/>;
}

/** Ambient ground is scenery, not new playable/tilled land. No ledger state lives here. */
export const GardenGround=memo(function GardenGround(){
  const id=useId().replaceAll(":","");
  return <g pointerEvents="none" aria-hidden="true">
    <defs><pattern id={id} patternUnits="userSpaceOnUse" width="320" height="320"><image href={charmvilleAssetFromSource("/images/charmville/workshop/clover-turf.png")} width="320" height="320"/></pattern></defs>
    <rect x="-80" y="-80" width="960" height="680" fill={`url(#${id})`}/>
    {[{x:4,y:7},{x:8,y:5}].map(cell=>{const p=projectCell(cell.x,cell.y),scale=120/cropAtlas.frameSize[0];return <image key={`entry-${cell.x}`} href="/images/charmville/original/access-path.png" x={p.x-cropAtlas.anchor[0]*scale} y={p.y-cropAtlas.anchor[1]*scale} width="120" height={cropAtlas.frameSize[1]*scale}/>;})}
    {Array.from({length:12},(_,y)=><FarmSprite key={y} name="planks_N" x={9} y={y-1}/>)}
    <FarmSprite name="planks_N" x={8} y={5}/>
    {/* A connected public-edge boardwalk and work deck; never new crop cells. */}
    {Array.from({length:6},(_,i)=><FarmSprite key={`walk-${i}`} name="planks_N" x={i+3} y={9}/>)}
    {[3,4,5].flatMap(x=>[10,11].map(y=><FarmSprite key={`deck-${x}-${y}`} name="planks_N" x={x} y={y}/>))}
    <FarmSprite name="planks_N" x={4} y={8}/>
    {[{x:1,y:1},{x:6,y:1},{x:1,y:6.8},{x:7.8,y:6.8},{x:2.5,y:10}].map((cell,index)=><WorkshopSprite key={`flowers-${index}`} name="flower-border" x={cell.x} y={cell.y} width={130}/>)}
  </g>;
});

export const GardenFence=memo(function GardenFence(){
  return <g pointerEvents="none" aria-hidden="true">
    {Array.from({length:9},(_,i)=>i===4?null:<FarmSprite key={`south-${i}`} name="fenceLow_N" x={i} y={8}/>)}
    {Array.from({length:9},(_,i)=>i===5?null:<FarmSprite key={`east-${i}`} name="fenceLow_E" x={8} y={i}/>)}
    {/* Modular CC0 timber shelter. All pieces use the source ground anchor. */}
    <WorkshopSprite name="seed-cottage" x={3.7} y={10.1} width={255}/>
    <FarmSprite name="hayBalesStacked_N" x={5.7} y={10} width={76}/>
    <FarmSprite name="sack_N" x={5.6} y={11} width={64}/>
    <FarmSprite name="sacksCrate_N" x={9.1} y={4.1} width={70}/>
  </g>;
});
