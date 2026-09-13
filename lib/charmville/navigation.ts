import type { Decoration } from "./layout";

export type GroundPoint = { x: number; y: number };
const STEP = .5;
const key = (p: GroundPoint) => `${Math.round(p.x / STEP)},${Math.round(p.y / STEP)}`;
export const plotGround = (index: number): GroundPoint => ({ x: 2.5 + (index % 3) * 2, y: 3.5 + Math.floor(index / 3) * 2 });

/** Presentation collision map. It cannot authorize a harvest or change server time. */
export function walkable(point: GroundPoint, trees: readonly Decoration[]): boolean {
  const {x,y}=point;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>9||y>9)return false;
  if(Math.abs(x-8)<.18&&Math.abs(y-5)>.42&&y<8)return false;
  if(Math.abs(y-8)<.18&&Math.abs(x-4)>.42&&x<8)return false;
  if(trees.some(tree=>Math.hypot(tree.x-x,tree.y-y)<.38))return false;
  for(let index=0;index<6;index++){
    const plot=plotGround(index);
    if(Math.abs(plot.x-x)<.81&&Math.abs(plot.y-y)<.81)return false;
  }
  return true;
}

export function nearestWalkable(point: GroundPoint, trees: readonly Decoration[]): GroundPoint | null {
  let nearest:GroundPoint|null=null,best=Infinity;
  for(let x=0;x<=9;x+=STEP)for(let y=0;y<=9;y+=STEP){
    const candidate={x,y},distance=Math.hypot(x-point.x,y-point.y);
    if(distance<best&&walkable(candidate,trees)){nearest=candidate;best=distance;}
  }
  return nearest;
}

/** A* on half cells. Diagonal movement cannot cut crop, fence or tree corners. */
export function findGroundPath(from: GroundPoint, to: GroundPoint, trees: readonly Decoration[]): GroundPoint[] {
  const start=nearestWalkable(from,trees),goal=nearestWalkable(to,trees);
  if(!start||!goal)return [];
  const startKey=key(start),goalKey=key(goal),open=new Map([[startKey,start]]);
  const costs=new Map([[startKey,0]]),parents=new Map<string,string>(),points=new Map([[startKey,start]]),closed=new Set<string>();
  while(open.size){
    let current=start,currentKey=startKey,best=Infinity;
    for(const [id,point] of open){const score=costs.get(id)!+Math.hypot(point.x-goal.x,point.y-goal.y);if(score<best){current=point;currentKey=id;best=score;}}
    open.delete(currentKey);
    if(currentKey===goalKey){
      const path:GroundPoint[]=[];let id=currentKey;
      while(id!==startKey){path.unshift(points.get(id)!);id=parents.get(id)!;}
      if(Math.hypot(start.x-from.x,start.y-from.y)>.02)path.unshift(start);
      return path;
    }
    closed.add(currentKey);
    for(const dx of [-STEP,0,STEP])for(const dy of [-STEP,0,STEP]){
      if(!dx&&!dy)continue;
      const next={x:current.x+dx,y:current.y+dy},id=key(next);
      if(closed.has(id)||!walkable(next,trees))continue;
      if(dx&&dy&&(!walkable({x:current.x+dx,y:current.y},trees)||!walkable({x:current.x,y:current.y+dy},trees)))continue;
      const cost=costs.get(currentKey)!+Math.hypot(dx,dy);
      if(cost>=(costs.get(id)??Infinity))continue;
      costs.set(id,cost);parents.set(id,currentKey);points.set(id,next);open.set(id,next);
    }
  }
  return [];
}

export function plotApproach(index:number,from:GroundPoint,trees:readonly Decoration[]):GroundPoint {
  const plot=plotGround(index);
  const candidates=[{x:plot.x-1,y:plot.y},{x:plot.x+1,y:plot.y},{x:plot.x,y:plot.y-1},{x:plot.x,y:plot.y+1}];
  let best=candidates[3],distance=Infinity;
  for(const candidate of candidates){
    if(!walkable(candidate,trees))continue;
    const path=findGroundPath(from,candidate,trees);
    if(!path.length&&Math.hypot(from.x-candidate.x,from.y-candidate.y)>.1)continue;
    if(path.length<distance){best=candidate;distance=path.length;}
  }
  return best;
}

/** Atlas 0=front/down, then down-left, left, up-left, back, up-right, right, down-right. */
export function facingForScreenVector(dx:number,dy:number):number {
  return ((Math.round(Math.atan2(-dx,dy)/(Math.PI/4))%8)+8)%8;
}

export function moveAlongGround(from:GroundPoint,screenX:number,screenY:number,seconds:number,trees:readonly Decoration[]):GroundPoint {
  if(!screenX&&!screenY)return from;
  let dx=screenX+screenY*2,dy=-screenX+screenY*2;
  const length=Math.hypot(dx,dy);dx/=length;dy/=length;
  const step=Math.min(seconds,.05)*2.5;
  const target={x:from.x+dx*step,y:from.y+dy*step};
  // Sample the segment so a narrow fence cannot be crossed between frames.
  for(let i=1;i<=4;i++)if(!walkable({x:from.x+(target.x-from.x)*i/4,y:from.y+(target.y-from.y)*i/4},trees))return from;
  return target;
}
