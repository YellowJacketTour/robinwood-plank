export type Lifecycle={type:'charmville:action-lifecycle';sessionId:string;localActionId:number;sequence:number;phase:'begin'|'contact'|'cancel';action:'till'|'plant'|'water'|'harvest';plotIndex:number;dmap:number;screen:number;x:number;y:number;direction:number};
export function readLifecycle(raw:unknown):Lifecycle|null{
 const p=raw as Lifecycle|null;
 if(!p||p.type!=='charmville:action-lifecycle'||typeof p.sessionId!=='string'||!/^[a-f0-9-]{36}$/i.test(p.sessionId)||!Number.isSafeInteger(p.localActionId)||p.localActionId<1||!Number.isSafeInteger(p.sequence)||p.sequence<1||!['begin','contact','cancel'].includes(p.phase)||!['till','plant','water','harvest'].includes(p.action)||!Number.isInteger(p.plotIndex)||p.plotIndex<0||p.plotIndex>2||p.dmap!==4||p.screen!==63||![p.x,p.y].every(Number.isFinite)||!Number.isInteger(p.direction)||p.direction<0||p.direction>3)return null;
 return p;
}
export type ResourceSnapshot={regionId:string;serverNow:string;beds:{id:number;stage:number;revision:string;readyAt:string|null;planterId:string|null;allowedActions?:string[]}[];seeds:string;produce:string};
export function nativeResourceProjection(snapshot:ResourceSnapshot,sessionId?:string,resolvedLocalActionId=0){
 const now=Date.parse(snapshot.serverNow);
 return {type:'charmville:resource-state',active:true,sessionId,resolvedLocalActionId,beds:snapshot.beds.map(b=>({id:b.id,stage:b.stage,allowedActions:(b.allowedActions??[]).filter(a=>['till','plant','water','harvest'].includes(a)),growthVisualPhase:b.stage===3?Math.max(0,Math.min(2,Math.floor((30000-(Date.parse(b.readyAt??'')-now))/10000))):0})),seeds:Math.min(200000,Number(snapshot.seeds)),produce:Math.min(200000,Number(snapshot.produce))};
}
/** One native action at a time; acknowledgments are projections, never authority. */
export function createNativeResourceClient(o:{read:()=>Promise<ResourceSnapshot>;actor:()=>Promise<{sequence:number;regionEpoch:number}>;post:(body:object)=>Promise<unknown>;send:(body:object)=>void;changed:()=>void;status:(message:string)=>void;uuid:()=>string}){
 let dead=false,current:{event:Lifecycle;id:string;cancelled:boolean;ready:Promise<void>}|null=null,reading=false,session='',sequence=0,readVersion=0;
 const send=(body:object)=>{if(!dead)o.send(body);};
 async function refresh(resolved?:Lifecycle){
  const version=++readVersion;const state=await o.read();if(dead)return;
  if(version===readVersion)send(nativeResourceProjection(state,resolved?.sessionId,resolved?.localActionId));return state;
 }
 async function observe(raw:unknown){
  const e=readLifecycle(raw);if(!e||dead)return;
  if(e.sessionId!==session){if(current)current.cancelled=true;session=e.sessionId;sequence=0;}
  if(e.sequence<=sequence)return;sequence=e.sequence;
  if(e.phase==='begin'){
   if(current){send({type:'charmville:action-authorization',sessionId:e.sessionId,localActionId:e.localActionId,accepted:false});return;}
   const pending={event:e,id:o.uuid(),cancelled:false,ready:Promise.resolve()};current=pending;
   pending.ready=(async()=>{
    try{
     const state=await refresh();const actor=await o.actor();if(dead||pending.cancelled)return;
     const bed=state?.beds.find(b=>b.id===e.plotIndex);if(!bed)throw Error('This bed is unavailable.');
     await o.post({phase:'begin',requestId:pending.id,bedId:e.plotIndex,kind:e.action,resourceRevision:bed.revision,regionEpoch:actor.regionEpoch,sequence:actor.sequence});
     if(dead||pending.cancelled){await o.post({phase:'cancel',requestId:pending.id});return;}
     send({type:'charmville:action-authorization',sessionId:e.sessionId,localActionId:e.localActionId,accepted:true});o.status('Working…');
    }catch(error){if(!dead){send({type:'charmville:action-authorization',sessionId:e.sessionId,localActionId:e.localActionId,accepted:false});o.status(error instanceof Error?error.message:'Could not start this action.');}if(current===pending)current=null;}
    finally{if(pending.cancelled&&current===pending)current=null;}
   })();await pending.ready;return;
  }
  const pending=current;if(!pending||pending.event.sessionId!==e.sessionId||pending.event.localActionId!==e.localActionId)return;
  if(e.phase==='cancel')pending.cancelled=true;
  await pending.ready;if(dead||current!==pending)return;
  try{
   const body={phase:e.phase==='cancel'?'cancel':'commit',requestId:pending.id};
   // An uncertain response retries the same receipt key, never a new harvest.
   try{await o.post(body);}catch(first){if(dead)return;try{await o.post(body);}catch{throw first;}}
   await refresh(e);if(!dead){o.changed();o.status(e.phase==='cancel'?'Action cancelled.':'Saved to the shared world.');}
  }catch(error){if(!dead){o.status(error instanceof Error?error.message:'Action could not be confirmed.');try{await o.post({phase:'cancel',requestId:pending.id});await refresh(e);}catch{/* Remain locked if authoritative state is unavailable. */}}}
  finally{if(current===pending)current=null;}
 }
 return {observe,async poll(){if(dead||current||reading)return;reading=true;try{await refresh();}catch{if(!dead)send({type:'charmville:resource-state',active:false,beds:[],seeds:0,produce:0});}finally{reading=false;}},dispose(){dead=true;if(current){current.cancelled=true;void o.post({phase:'cancel',requestId:current.id}).catch(()=>{});}current=null;}};
}
