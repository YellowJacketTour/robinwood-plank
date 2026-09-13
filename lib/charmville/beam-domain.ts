import type {Cell, Geometry} from './native-action-domain';

/** Unwired domain primitive. Trusted simulation ticks/geometry only; emits no
 * damage, inventory mutations or native animation. Units are map cells, not
 * screen pixels. Native directions: up, down, left, right. */
export type BeamDirection = 0 | 1 | 2 | 3;
export type BeamPolicy = {chargeTicks:number;fireTicks:number;recoveryTicks:number;contactEveryTicks:number};
export type BeamState = {started:number;checked:number;cancelledAt:number|null;policy:BeamPolicy};
const integer = (n:number) => Number.isSafeInteger(n) && n >= 0;
export function startBeam(tick:number, policy:BeamPolicy):BeamState {
  if (!integer(tick) || Object.values(policy).some(n=>!integer(n)||n<1||n>4096)
      || !Number.isSafeInteger(tick+policy.chargeTicks+policy.fireTicks+policy.recoveryTicks)) throw Error('Invalid beam schedule');
  return {started:tick,checked:tick,cancelledAt:null,policy:{...policy}};
}
/** Contacts are action-relative ordinals; caller persists checked tick and
 * deduplicates action ID + ordinal atomically. Cancellation wins on its tick.
 * Skipped ticks preserve cadence; rendering frame rate never creates contacts. */
export function advanceBeam(state:BeamState,tick:number,cancel=false) {
  if (!integer(tick)||tick<state.checked) throw Error('Nonmonotonic beam tick');
  const {chargeTicks,fireTicks,recoveryTicks,contactEveryTicks}=state.policy;
  const fire=state.started+chargeTicks, recover=fire+fireTicks, done=recover+recoveryTicks;
  const cancelledAt=state.cancelledAt ?? (cancel&&tick<done?tick:null);
  const contacts:number[]=[];
  for(let at=fire,ordinal=0;at<recover;at+=contactEveryTicks,ordinal++) {
    if(at>state.checked&&at<=tick&&(cancelledAt===null||at<cancelledAt)) contacts.push(ordinal);
  }
  const phase=cancelledAt!==null?'cancelled':tick<fire?'charge':tick<recover?'fire':tick<done?'recovery':'complete';
  return {state:{...state,checked:tick,cancelledAt},phase,contacts};
}

/** Sockets are authored per pose/direction by the asset adapter. Never guess a
 * Link hand offset from an unrelated atlas. Elevation changes presentation Y
 * only, leaving the collision origin on its ground plane. */
export function beamOrigin(ground:Cell,direction:BeamDirection,sockets:Readonly<Record<BeamDirection,Cell>>,elevation=0) {
  const socket=sockets[direction];
  if(!socket||![ground.x,ground.y,socket.x,socket.y,elevation].every(Number.isFinite)||elevation<0) throw Error('Invalid beam socket');
  const collision={x:ground.x+socket.x,y:ground.y+socket.y};
  return {collision,visual:{x:collision.x,y:collision.y-elevation}};
}

/** Cardinal rectangular beam clipped at the first wall or map edge. Thickness
 * is collision width; cosmetic glow must not be supplied here. Walls use raw
 * map cells, NOT the avatar-footprint-expanded actor geometry. */
export function clipBeam(origin:Cell,direction:BeamDirection,length:number,width:number,g:Geometry) {
  if(![0,1,2,3].includes(direction)||![origin.x,origin.y,length,width].every(Number.isFinite)
    ||length<0||length>4096||width<=0||width>64||!integer(g.width)||!integer(g.height)
    ||g.width<1||g.height<1||g.width>4096||g.height>4096
    ||origin.x<0||origin.y<0||origin.x>=g.width||origin.y>=g.height) throw Error('Invalid beam geometry');
  const horizontal=direction>=2, positive=direction===1||direction===3;
  const along=horizontal?origin.x:origin.y, across=horizontal?origin.y:origin.x;
  const extent=horizontal?g.width:g.height, crossExtent=horizontal?g.height:g.width;
  let distance=Math.min(length,positive?extent-along:along);
  if(across-width/2<0||across+width/2>crossExtent) distance=0;
  const from=Math.max(0,Math.floor(across-width/2)), to=Math.min(crossExtent-1,Math.ceil(across+width/2)-1);
  for(let a=Math.max(0,Math.floor(along-distance));a<=Math.min(extent-1,Math.floor(along+distance));a++) {
    const near=positive?a-along:along-a-1;
    if(near>distance||near<=-1) continue;
    for(let c=from;c<=to;c++) {
      if(g.blocked.has(horizontal?`${a},${c}`:`${c},${a}`)) distance=Math.min(distance,Math.max(0,near));
    }
  }
  return {origin:{...origin},end:{x:origin.x+(horizontal?(positive?distance:-distance):0),y:origin.y+(!horizontal?(positive?distance:-distance):0)},length:distance,width};
}
