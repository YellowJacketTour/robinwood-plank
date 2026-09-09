type Event={eventId:string;log:{targetId?:string;damage:number;appliedDamage?:number}[]};
type Snapshot={encounter:{id:string;speciesId:number;cell:{x:number;y:number};hp:number;maxHp:number;revision:string};events?:Event[]};
/** Read-only rendering message. Never accepted as damage or ownership authority. */
export function nativeEncounterProjection(raw:unknown){
 const s=raw as Snapshot|null,e=s?.encounter;
 const off={type:'charmville:world-encounter',active:false};
 if(!e||typeof e.id!=='string'||e.speciesId!==286||!e.cell||!Number.isInteger(e.cell.x)||!Number.isInteger(e.cell.y)||e.cell.x<0||e.cell.x>30||e.cell.y<0||e.cell.y>20||!Number.isInteger(e.hp)||!Number.isInteger(e.maxHp)||e.hp<0||e.maxHp<1||e.hp>e.maxHp||e.maxHp>65535||typeof e.revision!=='string'||!/^\d+$/.test(e.revision))return off;
 let damageEvent:{eventId:string;damage:number}|undefined;
 for(const event of s?.events??[]){
  if(!/^\d+$/.test(event.eventId)||!Array.isArray(event.log))continue;
  const damage=event.log.filter(hit=>hit.targetId===e.id).map(hit=>hit.appliedDamage??hit.damage).filter(damage=>Number.isInteger(damage)&&damage>0&&damage<=65535).reduce((sum,damage)=>sum+damage,0);
  if(damage>0&&(!damageEvent||BigInt(event.eventId)>BigInt(damageEvent.eventId)))damageEvent={eventId:event.eventId,damage:Math.min(65535,damage)};
 }
 return {type:'charmville:world-encounter',active:true,encounter:e,...(damageEvent?{damageEvent}:{})};
}
