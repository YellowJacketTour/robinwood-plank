import {nativeMaps,geometryFor} from './native-world';
import {nativeAtlas} from './native-atlas';

/** Candidate seamless geometry. Not selected by live admission until the quest,
 * collision footprint, camera and every native projection use region coordinates. */
export const meadowRegion={
 id:'native-meadow-region',width:nativeAtlas.width,height:nativeAtlas.height,tilePixels:8,
 screens:nativeAtlas.areas.map(area=>{
  const map=nativeMaps.find(map=>map.id===area.geometryId);
  if(!map)throw new Error('Missing region geometry');
  return {geometryId:map.id,revision:map.revision,screen:map.native.screen,dmap:map.native.dmap,x:area.x,y:area.y,width:area.width,height:area.height};
 }),
 blocked:new Set(nativeAtlas.areas.flatMap(area=>{
  const map=nativeMaps.find(map=>map.id===area.geometryId)!;
  return map.blocked.map(key=>{const [x,y]=key.split(',').map(Number);return `${x+area.x},${y+area.y}`;});
 })),
};
// Dilate AFTER stitching. Dilating each screen independently would reject an
// actor whose footprint legitimately straddles the former screen seam.
const footprint=nativeMaps[0].footprint;
if(nativeMaps.some(map=>map.tilePixels!==8||map.footprint.width!==footprint.width||map.footprint.height!==footprint.height))throw new Error('Incompatible region footprints');
export const meadowRegionGeometry=geometryFor({...nativeMaps[0],width:meadowRegion.width,height:meadowRegion.height,blocked:[...meadowRegion.blocked]});
export function regionPosition(dmap:number,screen:number,x:number,y:number){
 const area=meadowRegion.screens.find(s=>s.dmap===dmap&&s.screen===screen);
 if(!area||![x,y].every(Number.isFinite)||x<0||y<0||x>=area.width*8||y>=area.height*8)return null;
 return {x:area.x*8+x,y:area.y*8+y};
}
export function screenPosition(x:number,y:number){
 if(![x,y].every(Number.isFinite))return null;
 const area=meadowRegion.screens.find(s=>x>=s.x*8&&y>=s.y*8&&x<(s.x+s.width)*8&&y<(s.y+s.height)*8);
 return area?{dmap:area.dmap,screen:area.screen,x:x-area.x*8,y:y-area.y*8}:null;
}
