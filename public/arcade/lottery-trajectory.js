export const BALL_RADIUS=.16;
export function dispensePosition(seconds,radius=BALL_RADIUS){
  const dy=radius-BALL_RADIUS;
  const lerp=(a,b,t)=>a+(b-a)*Math.max(0,Math.min(1,t));
  if(seconds<1.4)return [0,-.25+dy,0];
  if(seconds<2.3)return [0,dy+lerp(-.25,-1.22,(seconds-1.4)/.9),0];
  if(seconds<3.6){const t=(seconds-2.3)/1.3;return [0,dy+lerp(-1.22,-1.36,t),lerp(0,1.48,t)];}
  return [0,-1.36+dy,1.48];
}
