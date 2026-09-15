const origins=['http://localhost:3017','http://127.0.0.1:3017'];
const actionNames={0:'till',1:'plant',2:'water',4:'harvest'},phaseNames=['begin','contact','cancel'];
const actionBits={till:1,plant:2,water:4,harvest:8};
let sessionId=crypto.randomUUID(),run=null,consumed=0,stateSequence=1,state=null,expires=0,stateWritten=0,resolvedAction=0;
const cropCodes={'oran-berry':1,'burning-heart':2},cropNames={1:'oran-berry',2:'burning-heart'};
let nativeProtocol=1,capabilitySignature='',capabilityAt=0;
const root=()=>FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
function send(data){for(const origin of origins)parent.postMessage({...data,sessionId},origin);}
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.includes(event.origin))return;
 const d=event.data;if(!d)return;
 if(d.type==='charmville:action-authorization'){
  if(d.sessionId!==sessionId||!Number.isSafeInteger(d.localActionId)||d.localActionId<1||typeof d.accepted!=='boolean'||typeof FS==='undefined')return;
  try{FS.writeFile(root()+'resource-authorization.txt',`${d.localActionId}|${d.accepted?1:0}`);}catch{}return;
 }
 if(d.type!=='charmville:resource-state'||typeof d.active!=='boolean')return;
 if(d.active){
  const v2=d.protocolVersion===2;
  if((v2&&nativeProtocol!==2)||(!v2&&d.beds?.some?.(b=>b.cropId&&b.cropId!=='oran-berry'))){state=null;stateSequence++;return;}
  if(!Array.isArray(d.beds)||d.beds.length!==3||d.beds.some((b,i)=>b.id!==i||!Number.isInteger(b.stage)||b.stage<0||b.stage>4||!Number.isInteger(b.growthVisualPhase)||b.growthVisualPhase<0||b.growthVisualPhase>2||(b.allowedActions!==undefined&&(!Array.isArray(b.allowedActions)||b.allowedActions.some(a=>!Object.hasOwn(actionBits,a))))))return;
  if(!Number.isSafeInteger(d.seeds)||d.seeds<0||d.seeds>200000||!Number.isSafeInteger(d.produce)||d.produce<0||d.produce>200000)return;
  if(v2){
   if(d.beds.some(b=>!Object.hasOwn(cropCodes,b.cropId)||!Array.isArray(b.plantCrops)||b.plantCrops.some(c=>!Object.hasOwn(cropCodes,c))))return;
   if(['oran-berry','burning-heart'].some(id=>!d.cropBalances?.[id]||['seeds','produce'].some(k=>!Number.isSafeInteger(d.cropBalances[id][k])||d.cropBalances[id][k]<0||d.cropBalances[id][k]>200000)))return;
  }
 }
 if(!d.active)resolvedAction=0;
 else if(d.sessionId===sessionId&&Number.isSafeInteger(d.resolvedLocalActionId)&&d.resolvedLocalActionId>=0)resolvedAction=Math.max(resolvedAction,d.resolvedLocalActionId);
 state=d.active?{beds:d.beds,seeds:d.seeds,produce:d.produce,resolved:resolvedAction,protocolVersion:d.protocolVersion===2?2:1,cropBalances:d.cropBalances}:null;expires=Date.now()+15000;stateSequence++;
});
function poll(){
 if(parent===window||typeof FS==='undefined')return;
 try{
  const directory=root();FS.mkdirTree(directory);
  const detected=FS.analyzePath(directory+'resource-protocol.txt').exists&&FS.readFile(directory+'resource-protocol.txt',{encoding:'utf8'}).replace(/\0/g,'').trim()==='2'?2:1;
  if(detected!==nativeProtocol){nativeProtocol=detected;if(state?.protocolVersion===2&&detected!==2)state=null;stateSequence++;}
  if(state&&Date.now()>expires){state=null;stateSequence++;}
  if(stateWritten!==stateSequence){
   const beds=state?.beds||Array.from({length:3},(_,id)=>({id,stage:0,growthVisualPhase:0}));
   const v2=nativeProtocol===2&&state?.protocolVersion===2;
   const values=[stateSequence,state?1:0,state?.resolved||0,state?.seeds||0,state?.produce||0,...beds.flatMap(b=>[b.stage,b.growthVisualPhase]),...beds.map(b=>(b.allowedActions||[]).reduce((mask,a)=>mask|actionBits[a],0))];
   // Old scripts must never interpret Heart growth as Oran artwork. Native v2
   // can still consume the ordinary file when a server declines negotiation.
   FS.writeFile(directory+'resource-state.txt',(v2?[stateSequence,0,0,0,0,...Array(9).fill(0)]:values).join('|'));
   const balances=state?.cropBalances;
   FS.writeFile(directory+'resource-state-v2.txt',[...values.slice(0,1),v2?1:0,...values.slice(2),2,...beds.map(b=>cropCodes[b.cropId]||1),balances?.['oran-berry']?.seeds||0,balances?.['oran-berry']?.produce||0,balances?.['burning-heart']?.seeds||0,balances?.['burning-heart']?.produce||0,...beds.map(b=>(b.plantCrops||[]).reduce((mask,id)=>mask|cropCodes[id],0))].join('|'));
   stateWritten=stateSequence;
  }
  if(!FS.analyzePath(directory+'action-run.txt').exists||!FS.analyzePath(directory+'lifecycle-sequence.txt').exists)return;
  const generation=Number(FS.readFile(directory+'action-run.txt',{encoding:'utf8'}).replace(/\0/g,''));
  if(!Number.isSafeInteger(generation)||generation<1)return;
  if(run!==generation){run=generation;consumed=0;sessionId=crypto.randomUUID();resolvedAction=0;if(state)state.resolved=0;stateSequence++;}
  const signature=`${sessionId}|${nativeProtocol}`;
  if((nativeProtocol===2||capabilitySignature.endsWith('|2'))&&(signature!==capabilitySignature||Date.now()-capabilityAt>=1000)){
   send({type:'charmville:resource-capabilities',protocolVersion:nativeProtocol,crops:nativeProtocol===2?['oran-berry','burning-heart']:['oran-berry']});capabilitySignature=signature;capabilityAt=Date.now();
  }
  const latest=Number(FS.readFile(directory+'lifecycle-sequence.txt',{encoding:'utf8'}).replace(/\0/g,''));if(!Number.isSafeInteger(latest)||latest<0)return;
  if(latest-consumed>64){send({type:'charmville:action-lifecycle-gap',fromSequence:consumed+1,toSequence:latest-64});consumed=latest-64;}
  while(consumed<latest){
   const sequence=consumed+1,v=FS.readFile(directory+`lifecycle-${sequence%64}.txt`,{encoding:'utf8'}).replace(/\0/g,'').split('|').map(Number);
   if(![10,11].includes(v.length)||v.some(n=>!Number.isFinite(n))||v[0]!==sequence)return;
   if(v.length===11&&(nativeProtocol!==2||state?.protocolVersion!==2||!Object.hasOwn(cropNames,v[10])))return;
   const [,localActionId,phase,action,plotIndex,dmap,screen,x,y,direction]=v;if(!phaseNames[phase]||!actionNames[action])return;
   send({type:'charmville:action-lifecycle',sequence,localActionId,phase:phaseNames[phase],action:actionNames[action],plotIndex,dmap,screen,x,y,direction,...(v.length===11?{protocolVersion:2,cropId:cropNames[v[10]]}:{})});consumed=sequence;
  }
 }catch(error){console.warn('Native resource bridge unavailable',error.message);}
}
const timer=setInterval(poll,100);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
