type Point={x:number;y:number};
export function wheelZoomFactor(delta:number,mode:number,pageHeight:number){
 if(!Number.isFinite(delta)||!Number.isFinite(pageHeight)||pageHeight<=0)return 1;
 const pixels=delta*(mode===1?16:mode===2?pageHeight:1);
 return Math.exp(-Math.max(-500,Math.min(500,pixels))*.002);
}
export function pinchMap(start:{distance:number;zoom:number;center:Point;midpoint:Point},current:{distance:number;midpoint:Point},pixelsPerWorldUnit:number){
 if(!Number.isFinite(pixelsPerWorldUnit)||pixelsPerWorldUnit<=0||!Number.isFinite(start.distance)||start.distance<=0||!Number.isFinite(current.distance)||current.distance<=0)return null;
 const zoom=Math.max(1,Math.min(4,start.zoom*current.distance/start.distance));
 const ratio=zoom/start.zoom;
 // Midpoints are offsets from the viewport centre, in CSS pixels. Keep the
 // world point beneath the starting fingers beneath their current midpoint.
 return {zoom,center:{x:start.center.x+start.midpoint.x/pixelsPerWorldUnit-current.midpoint.x/(pixelsPerWorldUnit*ratio),y:start.center.y+start.midpoint.y/pixelsPerWorldUnit-current.midpoint.y/(pixelsPerWorldUnit*ratio)}};
}
