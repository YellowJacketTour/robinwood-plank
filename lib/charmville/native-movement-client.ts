/** Same-origin transport for native movement. Native observations remain untrusted;
 * the server validates each step. No path interpolation, items or rewards. */
export type NativePosition={type:'charmville:position-observed';sessionId:string;sequence:number;dmap:number;screen:number;x:number;y:number;direction:number;z:number;fakeZ:number;appliedCorrectionSequence:number;authority:'local-observation'};
export type SavedActor={profileId:string;regionId:string;presenceRevision:string;geometryId:string;geometryRevision:string;tilePixels:number;cell:{x:number;y:number};sequence:number;regionEpoch:number;version:number};
export function readNativePosition(raw:unknown):NativePosition|null {
 const p=raw as NativePosition|null;
 if(!p||p.type!=='charmville:position-observed'||p.authority!=='local-observation'||typeof p.sessionId!=='string'||!/^[a-f0-9-]{36}$/i.test(p.sessionId)||!Number.isSafeInteger(p.sequence)||p.sequence<1||!Number.isInteger(p.dmap)||!Number.isInteger(p.screen)||![p.x,p.y,p.z,p.fakeZ].every(Number.isFinite)||p.x<0||p.x>255||p.y<0||p.y>175||!Number.isInteger(p.direction)||p.direction<0||p.direction>3||!Number.isSafeInteger(p.appliedCorrectionSequence)||p.appliedCorrectionSequence<0)return null;
 return p;
}
export function createNativeMovementClient(options:{request:(body?:object,signal?:AbortSignal)=>Promise<SavedActor>;correct:(payload:object)=>void;status:(message:string)=>void}) {
 let disposed=false,session='',seen=0,correction=0,waiting=0,actor:SavedActor|null=null;
 let pending:NativePosition[]=[],draining:Promise<void>|null=null,lastStepAt=0;
 const sameContext=(a:SavedActor,b:SavedActor)=>a.profileId===b.profileId&&a.regionId===b.regionId&&a.regionEpoch===b.regionEpoch&&a.geometryId===b.geometryId&&a.geometryRevision===b.geometryRevision;
 const synchronize=(snapshot:SavedActor)=>{
  if(actor&&sameContext(actor,snapshot)&&BigInt(snapshot.presenceRevision)>BigInt(actor.presenceRevision))actor={...actor,presenceRevision:snapshot.presenceRevision};
 };
 const accept=(snapshot:SavedActor)=>{
  const revision=actor&&sameContext(actor,snapshot)&&BigInt(actor.presenceRevision)>BigInt(snapshot.presenceRevision)?actor.presenceRevision:snapshot.presenceRevision;
  actor={...snapshot,presenceRevision:revision};
 };
 const abort=new AbortController();
 const correct=(position:NativePosition,reason:'spawn'|'rejected')=>{
  if(!actor||disposed)return;
  pending=[];
  waiting=++correction;
  options.correct({type:'charmville:position-correction',sessionId:position.sessionId,sequence:correction,dmap:4,screen:63,x:actor.cell.x*actor.tilePixels,y:actor.cell.y*actor.tilePixels,direction:position.direction,reason});
 };
 async function process(position:NativePosition){
  if(position.dmap!==4||position.screen!==63||position.z!==0||position.fakeZ!==0){options.status('This area or movement is not connected to saved positioning yet.');return;}
  if(waiting&&position.appliedCorrectionSequence<waiting)return;
  const run=session;
  try {
   if(!actor){const snapshot=await options.request(undefined,abort.signal);if(disposed||run!==session)return;accept(snapshot);correct(position,'spawn');options.status('Your position is connected. Combat remains local.');return;}
   const x=Math.floor(position.x/actor.tilePixels),y=Math.floor(position.y/actor.tilePixels);
   if(x===actor.cell.x&&y===actor.cell.y)return;
   if(Math.abs(x-actor.cell.x)>1||Math.abs(y-actor.cell.y)>1){correct(position,'rejected');return;}
   const stepMs=x!==actor.cell.x&&y!==actor.cell.y?142:100;
   const delay=stepMs-(Date.now()-lastStepAt);
   if(delay>0)await new Promise<void>(resolve=>setTimeout(resolve,delay));
   if(disposed||run!==session||!actor)return;
   lastStepAt=Date.now();
   const before=actor;
   const send=()=>options.request({x,y,sequence:before.sequence+1,regionEpoch:before.regionEpoch,presenceRevision:actor!.presenceRevision,geometryId:before.geometryId},abort.signal);
   let snapshot:SavedActor;
   try{snapshot=await send();}catch(error){
    if(disposed||run!==session)return;
    const recovered=await options.request(undefined,abort.signal);
    if(disposed||run!==session)return;
    // Retry only when the step demonstrably did not commit and admission alone
    // advanced. An ambiguous committed result must never be applied twice.
    if(sameContext(before,recovered)&&recovered.sequence===before.sequence&&recovered.cell.x===before.cell.x&&recovered.cell.y===before.cell.y&&BigInt(recovered.presenceRevision)>BigInt(before.presenceRevision)){
     accept(recovered);snapshot=await send();
    }else{accept(recovered);correct(position,'rejected');options.status(error instanceof Error?error.message:'Position sync interrupted.');return;}
   }
   if(disposed||run!==session)return;
   accept(snapshot);
   // Pace from acknowledgment, not dispatch: variable request latency can
   // otherwise make successive steps arrive closer together than allowed.
   lastStepAt=Date.now();
   options.status('Your position is connected. Combat remains local.');
  }catch(error){
   if(disposed||run!==session)return;
   options.status(error instanceof Error?error.message:'Position sync interrupted.');
   // Recover the actual committed state after both explicit rejection and an
   // ambiguous network result. Never retry with a newly invented sequence.
   try{const snapshot=await options.request(undefined,abort.signal);if(!disposed&&run===session){accept(snapshot);correct(position,'rejected');}}catch{if(run===session){actor=null;pending=[];}}
  }
 }
 function observe(raw:unknown):Promise<void>{
  const position=readNativePosition(raw);if(!position||disposed)return Promise.resolve();
  if(position.sessionId!==session){session=position.sessionId;seen=0;actor=null;correction=0;waiting=0;pending=[];}
  if(position.sequence<=seen)return draining??Promise.resolve();seen=position.sequence;
  // Retain observed cells during a request. Never synthesize missing path cells.
  // A bounded backlog falls back to authoritative correction, not unchecked travel.
  if(pending.length>=64)pending=[];
  pending.push(position);
  if(!draining)draining=(async()=>{while(pending.length&&!disposed){const next=pending.shift()!;await process(next);}})().finally(()=>{draining=null;});
  return draining;
 }
 return {observe,synchronize,dispose(){disposed=true;abort.abort();actor=null;pending=[];}};
}
