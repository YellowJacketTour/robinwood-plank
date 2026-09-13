import {SOURCE_SCREEN,screenFromAnchor,type WorldAnchor} from './world-coordinates';

export type SceneCamera={x:number;y:number;width:number;height:number};
export type WorldEntity={id:string;anchor:WorldAnchor;revision:number};
export type SceneScope={placeId:string;map:number;epoch:number};
/** Camera/terrain interest only. Server admission owns scope and entity custody.
 * This does not run the native simulation or authorize travel into a chunk. */
export function followWorldCamera(target:WorldAnchor,viewport:{width:number;height:number},zoom=1):SceneCamera {
 if(!screenFromAnchor(target)||!Number.isFinite(zoom)||zoom<=0||![viewport.width,viewport.height].every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid camera inputs');
 const width=Math.min(4096,viewport.width/zoom),height=Math.min(1408,viewport.height/zoom);
 return {x:Math.max(0,Math.min(4096-width,target.x-width/2)),y:Math.max(0,Math.min(1408-height,target.y-height/2)),width,height};
}

export function visibleTerrain(camera:SceneCamera,authored:ReadonlySet<number>,margin=1):number[]{
 if(![camera.x,camera.y,camera.width,camera.height].every(Number.isFinite)||camera.width<=0||camera.height<=0||!Number.isInteger(margin)||margin<0||margin>8)throw Error('Invalid terrain viewport');
 const left=Math.max(0,Math.floor(camera.x/SOURCE_SCREEN.width)-margin);
 const top=Math.max(0,Math.floor(camera.y/SOURCE_SCREEN.height)-margin);
 const right=Math.min(15,Math.ceil((camera.x+camera.width)/SOURCE_SCREEN.width)-1+margin);
 const bottom=Math.min(7,Math.ceil((camera.y+camera.height)/SOURCE_SCREEN.height)-1+margin);
 const result:number[]=[];
 for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){const screen=y*16+x;if(authored.has(screen))result.push(screen);}
 return result;
}

/** Session-scoped projection store. Camera changes only select terrain; entities
 * disappear solely through authoritative removals or an admitted place change.
 * Not durable storage: snapshots are supplied by the server on reconnect. */
export class WorldScene {
 private entities=new Map<string,WorldEntity>();
 private revisions=new Map<string,number>();
 private screens=new Set<number>();
 private scope:SceneScope;
 constructor(scope:SceneScope){this.validateScope(scope);this.scope={...scope};}
 private validateScope(scope:SceneScope){if(!scope.placeId||!Number.isSafeInteger(scope.map)||scope.map<1||!Number.isSafeInteger(scope.epoch)||scope.epoch<0)throw Error('Invalid scene scope');}
 enter(scope:SceneScope){
  this.validateScope(scope);
  if(scope.epoch<this.scope.epoch)return false;
  if(scope.epoch===this.scope.epoch)return scope.placeId===this.scope.placeId&&scope.map===this.scope.map;
  this.scope={...scope};this.entities.clear();this.revisions.clear();this.screens.clear();return true;
 }
 apply(scope:SceneScope,entity:WorldEntity){
  if(!this.matches(scope)||!entity.id||!Number.isSafeInteger(entity.revision)||entity.revision<0||entity.revision<=(this.revisions.get(entity.id)??-1)||entity.anchor.placeId!==scope.placeId||entity.anchor.map!==scope.map||!screenFromAnchor(entity.anchor))return false;
  this.entities.set(entity.id,{...entity,anchor:{...entity.anchor}});this.revisions.set(entity.id,entity.revision);return true;
 }
 remove(scope:SceneScope,id:string,revision:number){
  if(!this.matches(scope)||!id||!Number.isSafeInteger(revision)||revision<0||revision<=(this.revisions.get(id)??-1))return false;
  this.entities.delete(id);this.revisions.set(id,revision);return true;
 }
 private matches(scope:SceneScope){return scope.epoch===this.scope.epoch&&scope.placeId===this.scope.placeId&&scope.map===this.scope.map;}
 terrain(camera:SceneCamera,authored:ReadonlySet<number>){
  const next=new Set(visibleTerrain(camera,authored));
  const load=[...next].filter(s=>!this.screens.has(s));const unload=[...this.screens].filter(s=>!next.has(s));
  this.screens=next;return {load,unload};
 }
 snapshot(){return [...this.entities.values()].map(e=>({...e,anchor:{...e.anchor}}));}
}
