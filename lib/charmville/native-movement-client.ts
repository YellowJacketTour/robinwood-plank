import {admittedNativeRoom} from './native-topology';
/** Same-origin transport for native movement. Native observations remain untrusted;
 * the server validates each step. No path interpolation, items or rewards. */
export type NativePosition={type:'charmville:position-observed';sessionId:string;sequence:number;dmap:number;screen:number;x:number;y:number;direction:number;z:number;fakeZ:number;appliedCorrectionSequence:number;authority:'local-observation'};
export type SavedActor={pacedMovement?:boolean;native?:{dmap:number;screen:number};profileId:string;regionId:string;presenceRevision:string;geometryId:string;geometryRevision:string;tilePixels:number;cell:{x:number;y:number};sequence:number;regionEpoch:number;version:number};
export function readNativePosition(raw:unknown):NativePosition|null {
 const p=raw as NativePosition|null;
 if(!p||p.type!=='charmville:position-observed'||p.authority!=='local-observation'||typeof p.sessionId!=='string'||!/^[a-f0-9-]{36}$/i.test(p.sessionId)||!Number.isSafeInteger(p.sequence)||p.sequence<1||!Number.isInteger(p.dmap)||!Number.isInteger(p.screen)||![p.x,p.y,p.z,p.fakeZ].every(Number.isFinite)||p.x<0||p.x>255||p.y<0||p.y>175||!Number.isInteger(p.direction)||p.direction<0||p.direction>3||!Number.isSafeInteger(p.appliedCorrectionSequence)||p.appliedCorrectionSequence<0)return null;
 return p;
}
export type MovementDiagnostic={event:'placement'|'correction';cause:string;observationSequence:number;correctionSequence:number;from:{x:number;y:number;screen:number};to:{x:number;y:number;screen:number};queued:number};
export function createNativeMovementClient(options:{allowArrivalWarp?:boolean;allowBorderTravel?:boolean;request:(body?:object,signal?:AbortSignal)=>Promise<SavedActor>;correct:(payload:object)=>void;status:(message:string)=>void;diagnostic?:(event:MovementDiagnostic)=>void}) {
 let pendingArrival=false;
 let disposed=false,session='',seen=0,correction=0,waiting=0,actor:SavedActor|null=null;
 let overflow:NativePosition|null=null;
 let pending:NativePosition[]=[],draining:Promise<void>|null=null,lastStepAt=0,lastDispatchAt=0,correctedAt=0;
 let queueHighWater=0,droppedPaths=0,lastRequestMs=0,maxRequestMs=0;
 const observedAt=new WeakMap<NativePosition,number>();
 const request=async(body?:object,signal?:AbortSignal)=>{
  const started=performance.now();
  try{return await options.request(body,signal);}finally{lastRequestMs=Math.max(0,performance.now()-started);maxRequestMs=Math.max(maxRequestMs,lastRequestMs);}
 };
 const onActorMap=(p:NativePosition)=>p.dmap===(actor?.native?.dmap??4)&&p.screen===(actor?.native?.screen??63);
 const sameContext=(a:SavedActor,b:SavedActor)=>a.profileId===b.profileId&&a.regionId===b.regionId&&a.regionEpoch===b.regionEpoch&&a.geometryId===b.geometryId&&a.geometryRevision===b.geometryRevision;
 const synchronize=(snapshot:SavedActor)=>{
  if(actor&&sameContext(actor,snapshot)&&BigInt(snapshot.presenceRevision)>BigInt(actor.presenceRevision))actor={...actor,presenceRevision:snapshot.presenceRevision};
 };
 const accept=(snapshot:SavedActor)=>{
  const revision=actor&&sameContext(actor,snapshot)&&BigInt(actor.presenceRevision)>BigInt(snapshot.presenceRevision)?actor.presenceRevision:snapshot.presenceRevision;
  actor={...snapshot,presenceRevision:revision};
 };
 const abort=new AbortController();
 const correct=(position:NativePosition,reason:'spawn'|'rejected',cause=reason==='spawn'?'arrival-or-border':'placement-retry')=>{
  if(!actor||disposed)return;
  const queued=pending.length;
  pending=[];overflow=null;
  // A controller may reconnect while the native runtime keeps its receipt counter.
  correction=Math.max(correction,position.appliedCorrectionSequence)+1;
  waiting=correction;correctedAt=Date.now();
  // Coordinates and counters only: no account identity, credentials or payloads.
  // Diagnostics must never interrupt the actual correction handoff.
  try{options.diagnostic?.({event:reason==='spawn'?'placement':'correction',cause,observationSequence:position.sequence,correctionSequence:correction,from:{x:position.x,y:position.y,screen:position.screen},to:{x:actor.cell.x*actor.tilePixels,y:actor.cell.y*actor.tilePixels,screen:actor.native?.screen??63},queued});}catch{/* Optional local observer. */}
  options.correct({type:'charmville:position-correction',sessionId:position.sessionId,sequence:correction,dmap:actor.native?.dmap??4,screen:actor.native?.screen??63,x:actor.cell.x*actor.tilePixels,y:actor.cell.y*actor.tilePixels,direction:position.direction,reason});
 };
 async function process(position:NativePosition){
  // Explicit admission may recover a previously running native map. Ordinary
  // exploration after initialization never implicitly changes saved regions.
  if(position.z!==0||position.fakeZ!==0||(!onActorMap(position)&&!(options.allowArrivalWarp&&(!actor||pendingArrival))&&!(options.allowBorderTravel&&actor?.native&&admittedNativeRoom(position.dmap,position.screen)))){options.status('This area or movement is not connected to saved positioning yet.');return;}
  if(waiting&&position.appliedCorrectionSequence<waiting){
   // Native scripts can defer/drop placement during jumps or scripted actions.
   // Retry at a bounded rate once grounded instead of waiting forever.
   if(Date.now()-correctedAt>=1500)correct(position,pendingArrival?'spawn':'rejected');
   return;
  }
  if(pendingArrival){
   if(!onActorMap(position)){if(Date.now()-correctedAt>=1500)correct(position,'spawn');return;}
   pendingArrival=false;
  }
  const run=session;
  try {
   if(!actor){const snapshot=await request(undefined,abort.signal);if(disposed||run!==session)return;accept(snapshot);pendingArrival=!onActorMap(position);correct(position,'spawn');options.status('Your position is connected. Combat remains local.');return;}
   if(!onActorMap(position)){
    if(!admittedNativeRoom(position.dmap,position.screen)){options.status('This destination is not connected yet.');return;}
    // The final edge step may have just committed while the native screen
    // scroll was queued. Respect the same acknowledgment-based pacing as steps.
    const delay=100-(Date.now()-lastStepAt);
    if(delay>0)await new Promise<void>(resolve=>setTimeout(resolve,delay));
    if(disposed||run!==session||!actor)return;
    const before=actor;
    const snapshot=await request({destination:`native-adventure-d${position.dmap}-s${position.screen}`,sequence:before.sequence+1,regionEpoch:before.regionEpoch,presenceRevision:before.presenceRevision,geometryId:before.geometryId},abort.signal);
    if(disposed||run!==session)return;
    accept(snapshot);lastStepAt=Date.now();pendingArrival=!onActorMap(position);correct(position,'spawn');
    options.status('Your position is connected. Combat remains local.');return;
   }
   const x=Math.floor(position.x/actor.tilePixels),y=Math.floor(position.y/actor.tilePixels);
   if(x===actor.cell.x&&y===actor.cell.y)return;
   if(Math.abs(x-actor.cell.x)>1||Math.abs(y-actor.cell.y)>1){correct(position,'rejected','nonadjacent-observation');return;}
   const stepMs=x!==actor.cell.x&&y!==actor.cell.y?142:100;
   // Only a server explicitly advertising bounded turn waiting can safely
   // absorb network jitter. Legacy servers retain acknowledgment pacing.
   const paced=actor.pacedMovement===true;
   const delay=stepMs-(Date.now()-(paced?lastDispatchAt:lastStepAt));
   if(delay>0)await new Promise<void>(resolve=>setTimeout(resolve,delay));
   if(disposed||run!==session||!actor)return;
   lastStepAt=Date.now();lastDispatchAt=lastStepAt;
   const before=actor;
   const send=()=>request({x,y,sequence:before.sequence+1,regionEpoch:before.regionEpoch,presenceRevision:actor!.presenceRevision,geometryId:before.geometryId,...(paced?{waitForTurn:true}:{})},abort.signal);
   let snapshot:SavedActor;
   try{snapshot=await send();}catch(error){
    if(disposed||run!==session)return;
    const recovered=await request(undefined,abort.signal);
    if(disposed||run!==session)return;
    // Retry only when the step demonstrably did not commit and admission alone
    // advanced. An ambiguous committed result must never be applied twice.
    if(sameContext(before,recovered)&&recovered.sequence===before.sequence+1&&recovered.cell.x===x&&recovered.cell.y===y){
     // A lost HTTP response is not rejected movement. If the authoritative
     // read confirms this exact step committed, retain the queued observed
     // trail instead of warping native play back to an older sampled frame.
     // Different cells, epochs or additional steps still require correction.
     snapshot=recovered;
    }else if(sameContext(before,recovered)&&recovered.sequence===before.sequence&&recovered.cell.x===before.cell.x&&recovered.cell.y===before.cell.y&&BigInt(recovered.presenceRevision)>BigInt(before.presenceRevision)){
     accept(recovered);snapshot=await send();
    }else{accept(recovered);correct(position,'rejected','step-rejected-or-conflicting-state');options.status(error instanceof Error?error.message:'Position sync interrupted.');return;}
   }
   if(disposed||run!==session)return;
   accept(snapshot);
   // Retain acknowledgment time for legacy pacing and border travel. Negotiated
   // walking uses dispatch time; a delayed reply never creates a catch-up loop
   // because each next dispatch establishes a fresh interval.
   lastStepAt=Date.now();
   options.status('Your position is connected. Combat remains local.');
  }catch(error){
   if(disposed||run!==session)return;
   options.status(error instanceof Error?error.message:'Position sync interrupted.');
   // Recover the actual committed state after both explicit rejection and an
   // ambiguous network result. Never retry with a newly invented sequence.
   try{const snapshot=await request(undefined,abort.signal);if(!disposed&&run===session){accept(snapshot);correct(position,'rejected','request-recovery');}}catch{if(run===session){actor=null;pending=[];}}
  }
 }
 function observe(raw:unknown):Promise<void>{
  const position=readNativePosition(raw);if(!position||disposed)return Promise.resolve();
  if(position.sessionId!==session){session=position.sessionId;seen=0;actor=null;correction=0;waiting=0;pendingArrival=false;pending=[];overflow=null;}
  if(position.sequence<=seen)return draining??Promise.resolve();seen=position.sequence;
  // Once continuity is lost, retain only the latest observation for the
  // resynchronization handoff. Do not resume a coincidentally adjacent tail.
  if(overflow){overflow=position;return draining??Promise.resolve();}
  // Native frames frequently repeat a cell while a request is in flight. Keep
  // those frames from evicting real path cells from the bounded queue. Receipt,
  // map and elevation changes must remain distinct for placement/landing gates.
  const last=pending[pending.length-1],pixels=actor?.tilePixels;
  if(last&&pixels&&last.sessionId===position.sessionId&&last.dmap===position.dmap&&last.screen===position.screen&&last.z===position.z&&last.fakeZ===position.fakeZ&&last.appliedCorrectionSequence===position.appliedCorrectionSequence&&Math.floor(last.x/pixels)===Math.floor(position.x/pixels)&&Math.floor(last.y/pixels)===Math.floor(position.y/pixels)){
   observedAt.set(position,observedAt.get(last)??performance.now());
   pending[pending.length-1]=position;
   return draining??Promise.resolve();
  }
  // Retain observed cells during a request. Never synthesize missing path cells.
  // A bounded backlog falls back to authoritative correction, not unchecked travel.
  if(pending.length>=64){
   droppedPaths++;pending=[];overflow=position;
   options.status('Connection is behind. Waiting for the saved position before resuming.');
   return draining??Promise.resolve();
  }
  observedAt.set(position,performance.now());
  pending.push(position);queueHighWater=Math.max(queueHighWater,pending.length);
  if(!draining)draining=(async()=>{
   while((pending.length||overflow)&&!disposed){
    if(overflow){
     const latest=overflow;overflow=null;
     // The in-flight request (including ambiguous-result recovery) has settled.
     // Its accepted snapshot is the sole placement authority, never the tail.
     if(actor){correct(latest,'rejected','observation-backlog-overflow');}
     continue;
    }
    const next=pending.shift()!;await process(next);
   }
  })().finally(()=>{draining=null;});
  return draining;
 }
 return {observe,synchronize,metrics(){return {queued:pending.length,resynchronizing:overflow!==null,queueHighWater,droppedPaths,lastRequestMs:Math.round(lastRequestMs),maxRequestMs:Math.round(maxRequestMs),oldestQueuedMs:pending.length?Math.round(Math.max(0,performance.now()-(observedAt.get(pending[0])??performance.now()))):0};},dispose(){disposed=true;abort.abort();actor=null;pending=[];overflow=null;}};
}
