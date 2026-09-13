/** Authored placement of the two extracted screens. Physical geography is
 * independent of the account/public instance which owns its contents. */
export const nativeAtlas={width:64,height:22,areas:[
 {geometryId:'native-adventure-d4-s62',label:'Western path',x:0,y:0,width:32,height:22},
 {geometryId:'native-adventure-d4-s63',label:'Meadow',x:32,y:0,width:32,height:22},
]} as const;
export function atlasPoint(geometryId:string,cell:{x:number;y:number}){
 const area=nativeAtlas.areas.find(area=>area.geometryId===geometryId);
 if(!area||!Number.isFinite(cell.x)||!Number.isFinite(cell.y)||cell.x<0||cell.y<0||cell.x>=area.width||cell.y>=area.height)return null;
 return {x:area.x+cell.x,y:area.y+cell.y};
}
