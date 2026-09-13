import meadow from './geometry/native-adventure-d4-s63.json';
import west from './geometry/native-adventure-d4-s62.json';
import {connectedNativeRooms} from './native-topology';
import {spawnActor,type ActorState,type Geometry} from './native-action-domain';
export const nativeMaps=[meadow,west];
export const mapByRevision=(revision:string)=>nativeMaps.find(map=>map.revision===revision);
export function geometryFor(map:typeof nativeMaps[number]):Geometry{
 const raw=new Set(map.blocked),blocked=new Set<string>();
 const width=map.width-map.footprint.width+1,height=map.height-map.footprint.height+1;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let dy=0;dy<map.footprint.height;dy++)for(let dx=0;dx<map.footprint.width;dx++)if(raw.has(`${x+dx},${y+dy}`))blocked.add(`${x},${y}`);
 return {width,height,blocked};
}
const geometries=new Map(nativeMaps.map(map=>[map.id,geometryFor(map)]));
export const nativeMapGeometry=(map:typeof nativeMaps[number])=>geometries.get(map.id)!;
/** Only the extracted, paired western border is enabled. No arbitrary warps. */
export function crossNativeBorder(state:ActorState,from:typeof nativeMaps[number],destination:unknown,now:number){
 const to=nativeMaps.find(map=>map.id===destination);
 if(!to||!connectedNativeRooms(from.native,to.native))throw Error('Unconnected destination');
 const westward=to.native.screen<from.native.screen;
 const edge=westward?0:nativeMapGeometry(from).width-1;
 if(state.cell.x!==edge||state.cell.y<4||state.cell.y>12)throw Error('Walk to the connected border before traveling');
 if(now<state.lastMoveAt+100)throw Error('Travel too fast');
 const cell={x:westward?nativeMapGeometry(to).width-1:0,y:state.cell.y};
 const next=spawnActor(nativeMapGeometry(to),cell,state.regionEpoch+1,now);
 return {map:to,state:next};
}
