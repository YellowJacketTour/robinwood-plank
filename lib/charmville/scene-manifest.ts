/** Offline scene compilation only. A valid manifest does not authorize a player,
 * add a live destination, or make its source artwork available. */
type Point = Readonly<{x:number;y:number}>;
type Scene = Readonly<{
 id:string; spaceId:string; floor:number; sourceId:string; sourceRoom:string;
 revision:string; width:number; height:number; tilePixels:number;
 origin:Point; footprint:Readonly<{width:number;height:number}>; blocked:readonly string[];
}>;
type Entrance = Readonly<{id:string;from:string;to:string;returnId:string;trigger:Point;arrival:Point}>;
export type SceneManifest = Readonly<{version:1;scenes:readonly Scene[];entrances:readonly Entrance[]}>;

function record(value:unknown,label:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${label}: expected object`);
 return value as Record<string,unknown>;
}
function id(value:unknown,label:string):string{
 if(typeof value!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(value))throw Error(`${label}: invalid identity`);
 return value;
}
function integer(value:unknown,label:string,min:number,max:number):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw Error(`${label}: out of bounds`);
 return value;
}
function point(value:unknown,label:string,min=0,max=65535):Point{
 const p=record(value,label);
 return Object.freeze({x:integer(p.x,`${label}.x`,min,max),y:integer(p.y,`${label}.y`,min,max)});
}
function list(value:unknown,label:string,max:number):unknown[]{
 if(!Array.isArray(value)||value.length>max)throw Error(`${label}: invalid list`);
 return value;
}
function contains(scene:Scene,p:Point){
 return Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<scene.width*scene.tilePixels&&p.y<scene.height*scene.tilePixels;
}

export function compileSceneManifest(input:unknown){
 const raw=record(input,'manifest');
 if(raw.version!==1)throw Error('Unsupported scene manifest version');
 const sceneIds=new Set<string>();
 const sourceRooms=new Set<string>();
 let totalCells=0;
 const scenes=list(raw.scenes,'scenes',256).map((value,index):Scene=>{
  const s=record(value,`scene ${index}`),sceneId=id(s.id,'scene.id');
  if(sceneIds.has(sceneId))throw Error('Duplicate scene identity');sceneIds.add(sceneId);
  const sourceId=id(s.sourceId,'sourceId'),sourceRoom=id(s.sourceRoom,'sourceRoom');
  const spaceId=id(s.spaceId,'spaceId'),floor=integer(s.floor,'floor',-128,127);
  const sourceKey=JSON.stringify([spaceId,floor,sourceId,sourceRoom]);
  if(sourceRooms.has(sourceKey))throw Error('Duplicate source room in one space/floor');sourceRooms.add(sourceKey);
  if(typeof s.revision!=='string'||!/^[a-f0-9]{64}$/.test(s.revision))throw Error('Expected SHA256 geometry revision');
  const width=integer(s.width,'width',1,65536),height=integer(s.height,'height',1,65536);
  if(width*height>1048576)throw Error('Scene exceeds cell budget');
  totalCells+=width*height;
  if(totalCells>4194304)throw Error('Manifest exceeds total cell budget');
  const tilePixels=integer(s.tilePixels,'tilePixels',1,256);
  const footprint=record(s.footprint,'footprint');
  const blocked=new Set<string>();
  for(const cell of list(s.blocked,'blocked',1048576)){
   if(typeof cell!=='string'||! /^(0|[1-9]\d*),(0|[1-9]\d*)$/.test(cell))throw Error('Invalid blocked cell');
   const [x,y]=cell.split(',').map(Number);
   if(x>=width||y>=height||blocked.has(cell))throw Error('Duplicate or out-of-bounds blocked cell');
   blocked.add(cell);
  }
  return Object.freeze({id:sceneId,spaceId,floor,sourceId,sourceRoom,revision:s.revision,width,height,tilePixels,
   origin:point(s.origin,'origin',-16777216,16777216),
   footprint:Object.freeze({width:integer(footprint.width,'footprint.width',1,Math.min(width,64)),height:integer(footprint.height,'footprint.height',1,Math.min(height,64))}),
   blocked:Object.freeze([...blocked])});
 });
 if(!scenes.length)throw Error('At least one scene required');
 for(let i=0;i<scenes.length;i++)for(let j=i+1;j<scenes.length;j++){
  const a=scenes[i],b=scenes[j];
  if(a.spaceId===b.spaceId&&a.floor===b.floor&&a.origin.x<b.origin.x+b.width*b.tilePixels&&b.origin.x<a.origin.x+a.width*a.tilePixels&&a.origin.y<b.origin.y+b.height*b.tilePixels&&b.origin.y<a.origin.y+a.height*a.tilePixels)throw Error('Scenes overlap in one space/floor');
 }
 const byId=new Map(scenes.map(scene=>[scene.id,scene]));
 const solids=new Map(scenes.map(scene=>[scene.id,new Set(scene.blocked)]));
 const canStand=(scene:Scene,cell:Point)=>{
  if(!Number.isSafeInteger(cell.x)||!Number.isSafeInteger(cell.y)||cell.x<0||cell.y<0||cell.x+scene.footprint.width>scene.width||cell.y+scene.footprint.height>scene.height)return false;
  const blocked=solids.get(scene.id)!;
  for(let y=0;y<scene.footprint.height;y++)for(let x=0;x<scene.footprint.width;x++)if(blocked.has(`${cell.x+x},${cell.y+y}`))return false;
  return true;
 };
 const entranceIds=new Set<string>();
 const triggerIds=new Set<string>();
 const entrances=list(raw.entrances,'entrances',4096).map((value,index):Entrance=>{
  const e=record(value,`entrance ${index}`),entranceId=id(e.id,'entrance.id');
  if(entranceIds.has(entranceId))throw Error('Duplicate entrance identity');entranceIds.add(entranceId);
  const from=id(e.from,'entrance.from'),to=id(e.to,'entrance.to');
  const source=byId.get(from),target=byId.get(to);
  if(!source||!target||from===to)throw Error('Entrance must connect two known distinct scenes');
  const trigger=point(e.trigger,'trigger'),arrival=point(e.arrival,'arrival');
  if(!canStand(source,trigger)||!canStand(target,arrival))throw Error('Entrance trigger/arrival obstructed or outside actor bounds');
  const key=JSON.stringify([from,trigger.x,trigger.y]);
  if(triggerIds.has(key))throw Error('Ambiguous entrance trigger');triggerIds.add(key);
  return Object.freeze({id:entranceId,from,to,returnId:id(e.returnId,'returnId'),trigger,arrival});
 });
 const byEntrance=new Map(entrances.map(e=>[e.id,e]));
 for(const e of entrances){
  const back=byEntrance.get(e.returnId);
  if(!back||back.returnId!==e.id||back.from!==e.to||back.to!==e.from||back.trigger.x!==e.arrival.x||back.trigger.y!==e.arrival.y||back.arrival.x!==e.trigger.x||back.arrival.y!==e.trigger.y)throw Error('Entrance lacks exact reciprocal return');
 }
 const manifest:SceneManifest=Object.freeze({version:1,scenes:Object.freeze(scenes),entrances:Object.freeze(entrances)});
 return Object.freeze({manifest,
  /** Input and output positions are pixels. Bounds are half-open; no clamping. */
  toWorld(sceneId:string,local:Point){
   const scene=byId.get(sceneId);if(!scene||!contains(scene,local))return null;
   return {spaceId:scene.spaceId,floor:scene.floor,x:scene.origin.x+local.x,y:scene.origin.y+local.y};
  },
  toLocal(spaceId:string,floor:number,world:Point){
   const scene=scenes.find(s=>s.spaceId===spaceId&&s.floor===floor&&contains(s,{x:world.x-s.origin.x,y:world.y-s.origin.y}));
   return scene?{sceneId:scene.id,x:world.x-scene.origin.x,y:world.y-scene.origin.y}:null;
  },
  /** Cell coordinates, not pixels. Caller still owns admission and movement rules. */
  entranceAt(sceneId:string,entranceId:string,cell:Point){
   const e=byEntrance.get(entranceId);
   return e&&e.from===sceneId&&cell.x===e.trigger.x&&cell.y===e.trigger.y?{sceneId:e.to,cell:{...e.arrival},returnId:e.returnId}:null;
  },
 });
}
