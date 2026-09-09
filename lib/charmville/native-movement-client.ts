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
 let disposed=false,session='',seen=0,correction=0,waiting=0,actor:SavedActor|null=null,busy=false;
 const abort=new AbortController();
 const correct=(position:NativePosition,reason:'spawn'|'rejected')=>{
  if(!actor||disposed)return;
  waiting=++correction;
  options.correct({type:'charmville:position-correction',sessionId:position.sessionId,sequence:correction,dmap:4,screen:63,x:actor.cell.x*actor.tilePixels,y:actor.cell.y*actor.tilePixels,direction:position.direction,reason});
 };
 async function observe(raw:unknown){
  const position=readNativePosition(raw);if(!position||disposed||busy)return;
  if(position.sessionId!==session){session=position.sessionId;seen=0;actor=null;correction=0;waiting=0;}
  if(position.sequence<=seen)return;seen=position.sequence;
  if(position.dmap!==4||position.screen!==63||position.z!==0||position.fakeZ!==0){options.status('This area or movement is not connected to saved positioning yet.');return;}
  if(waiting&&position.appliedCorrectionSequence<waiting)return;
  const run=session;
  busy=true;
  try {
   if(!actor){actor=await options.request(undefined,abort.signal);if(disposed||run!==session)return;correct(position,'spawn');options.status('Your position is connected. Combat remains local.');return;}
   const x=Math.floor(position.x/actor.tilePixels),y=Math.floor(position.y/actor.tilePixels);
   if(x===actor.cell.x&&y===actor.cell.y)return;
   if(Math.abs(x-actor.cell.x)>1||Math.abs(y-actor.cell.y)>1){correct(position,'rejected');return;}
   actor=await options.request({x,y,sequence:actor.sequence+1,regionEpoch:actor.regionEpoch,presenceRevision:actor.presenceRevision,geometryId:actor.geometryId},abort.signal);
   if(disposed||run!==session)return;
   options.status('Your position is connected. Combat remains local.');
  }catch(error){
   if(disposed)return;
   options.status(error instanceof Error?error.message:'Position sync interrupted.');
   // Recover the actual committed state after both explicit rejection and an
   // ambiguous network result. Never retry with a newly invented sequence.
   try{actor=await options.request(undefined,abort.signal);if(!disposed&&run===session)correct(position,'rejected');}catch{actor=null;}
  }finally{busy=false;}
 }
 return {observe,dispose(){disposed=true;abort.abort();actor=null;}};
}
