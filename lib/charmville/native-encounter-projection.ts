type Cell = {x:number;y:number};
type DamageEvent = {eventId:string;damage:number;actorId?:string;actorSpeciesId?:number;moveId?:number;actorCell?:Cell};
const record = (value:unknown): Record<string,unknown>|null => value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const integer = (value:unknown,min:number,max:number):value is number => typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const cell = (value:unknown):value is Cell => {const c=record(value);return !!c&&integer(c.x,0,30)&&integer(c.y,0,20);};
const sequence = (value:unknown):value is string => typeof value==='string'&&/^\d{1,20}$/.test(value);

/** Read-only rendering message. Never accepted as damage or ownership authority. */
export function nativeEncounterProjection(raw:unknown){
 const snapshot=record(raw),e=record(snapshot?.encounter);
 const off={type:'charmville:world-encounter',active:false};
 if(!e||e.captured===true||typeof e.id!=='string'||e.speciesId!==286||!cell(e.cell)||!integer(e.hp,0,65535)||!integer(e.maxHp,1,65535)||e.hp>e.maxHp||!sequence(e.revision))return off;
 const projected=new Map<string,DamageEvent>();
 for(const rawEvent of Array.isArray(snapshot?.events)?snapshot.events:[]){
  const event=record(rawEvent);
  if(!event||!sequence(event.eventId)||!Array.isArray(event.log))continue;
  const hits=event.log.map(record).filter((hit):hit is Record<string,unknown>=>!!hit&&hit.targetId===e.id&&integer(hit.appliedDamage??hit.damage,1,65535));
  if(!hits.length)continue;
  const damage=Math.min(65535,hits.reduce((sum,hit)=>sum+Number(hit.appliedDamage??hit.damage),0));
  const damageEvent:DamageEvent={eventId:event.eventId,damage};
  // A single attributable strike can select source animation. Aggregate events cannot.
  const hit=hits.length===1?hits[0]:null;
  if(hit&&typeof hit.actor==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hit.actor)&&integer(hit.actorSpeciesId,1,65535)&&integer(hit.moveId,1,65535)&&cell(hit.actorCell)){
   Object.assign(damageEvent,{actorId:hit.actor,actorSpeciesId:hit.actorSpeciesId,moveId:hit.moveId,actorCell:{x:hit.actorCell.x,y:hit.actorCell.y}});
  }
  projected.set(event.eventId,damageEvent);
 }
 const damageEvents=[...projected.values()].sort((a,b)=>BigInt(a.eventId)<BigInt(b.eventId)?-1:1).slice(-16);
 const damageEvent=damageEvents.at(-1);
 return {type:'charmville:world-encounter',active:true,encounter:{id:e.id,speciesId:e.speciesId,cell:{x:e.cell.x,y:e.cell.y},hp:e.hp,maxHp:e.maxHp,revision:e.revision},...(damageEvent?{damageEvent,damageEvents}:{})};
}

/** Validate only the recorded capture receipt; no client target or odds are accepted. */
export function nativeCaptureProjection(raw:unknown){
 const r=record(raw);
 if(!r||typeof r.eventId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.eventId)||!cell(r.actorCell)||!cell(r.targetCell)||typeof r.captured!=='boolean'||!integer(r.shakes,0,4)||r.captured!==(r.shakes===4))return null;
 return {type:'charmville:capture-event',eventId:r.eventId,actorCell:{...r.actorCell},targetCell:{...r.targetCell},captured:r.captured,shakes:r.shakes};
}