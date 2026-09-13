/** Stable source-map coordinates, independent of loaded rectangular regions and cameras.
 * A place ID is supplied by authenticated world admission, never by this converter.
 * Coordinates do not grant traversal or access: collision and permissions remain authoritative.
 */
export const SOURCE_SCREEN = {width:256,height:176,columns:16,rows:8} as const;
export type WorldAnchor = {placeId:string;map:number;x:number;y:number};
const validScreen=(screen:number)=>Number.isInteger(screen)&&screen>=0&&screen<128;
const validMap=(map:number)=>Number.isInteger(map)&&map>0;
const validRegion=(origin:number,width:number,height:number)=>validScreen(origin)&&Number.isInteger(width)&&Number.isInteger(height)&&width>=1&&height>=1&&origin%16+width<=16&&Math.floor(origin/16)+height<=8;

export function anchorFromScreen(placeId:string,map:number,screen:number,x:number,y:number):WorldAnchor|null {
 if(!placeId||!validMap(map)||!validScreen(screen)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>=256||y<0||y>=176)return null;
 return {placeId,map,x:(screen%16)*256+x,y:Math.floor(screen/16)*176+y};
}

export function screenFromAnchor(anchor:WorldAnchor){
 const {placeId,map,x,y}=anchor;
 if(!placeId||!validMap(map)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=4096||y>=1408)return null;
 return {screen:Math.floor(y/176)*16+Math.floor(x/256),x:x%256,y:y%176};
}

/** Region origin is not the hero's current screen. Convert once at the boundary. */
export function anchorFromRegion(placeId:string,map:number,origin:number,width:number,height:number,x:number,y:number):WorldAnchor|null {
 if(!validRegion(origin,width,height)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=width*256||y>=height*176)return null;
 return anchorFromScreen(placeId,map,origin+Math.floor(x/256)+Math.floor(y/176)*16,x%256,y%176);
}

/** Convert into an already selected region; this does not select or admit a place. */
export function regionFromAnchor(anchor:WorldAnchor,placeId:string,map:number,origin:number,width:number,height:number):{x:number;y:number}|null {
 if(anchor.placeId!==placeId||anchor.map!==map||!screenFromAnchor(anchor)||!validRegion(origin,width,height))return null;
 const x=anchor.x-(origin%16)*256;
 const y=anchor.y-Math.floor(origin/16)*176;
 if(x<0||y<0||x>=width*256||y>=height*176)return null;
 return {x,y};
}

/** Rendering subtracts camera position; it never mutates the saved anchor. */
export function projectAnchor(anchor:WorldAnchor,camera:WorldAnchor){
 if(anchor.placeId!==camera.placeId||anchor.map!==camera.map||!screenFromAnchor(anchor)||!screenFromAnchor(camera))return null;
 return {x:anchor.x-camera.x,y:anchor.y-camera.y};
}
