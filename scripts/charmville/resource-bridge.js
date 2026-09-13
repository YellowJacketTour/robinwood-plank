const origins=['http://localhost:3017','http://127.0.0.1:3017'];
const actionNames={0:'till',1:'plant',2:'water',4:'harvest'},phaseNames=['begin','contact','cancel'];
const actionBits={till:1,plant:2,water:4,harvest:8};
let sessionId=crypto.randomUUID(),run=null,consumed=0,stateSequence=1,state=null,expires=0,stateWritten=0,resolvedAction=0;
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
  if(!Array.isArray(d.beds)||d.beds.length!==3||d.beds.some((b,i)=>b.id!==i||!Number.isInteger(b.stage)||b.stage<0||b.stage>4||!Number.isInteger(b.growthVisualPhase)||b.growthVisualPhase<0||b.growthVisualPhase>2||(b.allowedActions!==undefined&&(!Array.isArray(b.allowedActions)||b.allowedActions.some(a=>!Object.hasOwn(actionBits,a))))))return;
  if(!Number.isSafeInteger(d.seeds)||d.seeds<0||d.seeds>200000||!Number.isSafeInteger(d.produce)||d.produce<0||d.produce>200000)return;
 }
 if(!d.active)resolvedAction=0;
 else if(d.sessionId===sessionId&&Number.isSafeInteger(d.resolvedLocalActionId)&&d.resolvedLocalActionId>=0)resolvedAction=Math.max(resolvedAction,d.resolvedLocalActionId);
 state=d.active?{beds:d.beds,seeds:d.seeds,produce:d.produce,resolved:resolvedAction}:null;expires=Date.now()+15000;stateSequence++;
});
function poll(){
 if(parent===window||typeof FS==='undefined')return;
 try{
  const directory=root();FS.mkdirTree(directory);
  if(state&&Date.now()>expires){state=null;stateSequence++;}
  if(stateWritten!==stateSequence){const beds=state?.beds||Array.from({length:3},(_,id)=>({id,stage:0,growthVisualPhase:0}));FS.writeFile(directory+'resource-state.txt',[stateSequence,state?1:0,state?.resolved||0,state?.seeds||0,state?.produce||0,...beds.flatMap(b=>[b.stage,b.growthVisualPhase]),...beds.map(b=>(b.allowedActions||[]).reduce((mask,a)=>mask|actionBits[a],0))].join('|'));stateWritten=stateSequence;}
  if(!FS.analyzePath(directory+'action-run.txt').exists||!FS.analyzePath(directory+'lifecycle-sequence.txt').exists)return;
  const generation=Number(FS.readFile(directory+'action-run.txt',{encoding:'utf8'}).replace(/\0/g,''));
  if(!Number.isSafeInteger(generation)||generation<1)return;
  if(run!==generation){run=generation;consumed=0;sessionId=crypto.randomUUID();resolvedAction=0;if(state)state.resolved=0;stateSequence++;}
  const latest=Number(FS.readFile(directory+'lifecycle-sequence.txt',{encoding:'utf8'}).replace(/\0/g,''));if(!Number.isSafeInteger(latest)||latest<0)return;
  if(latest-consumed>64){send({type:'charmville:action-lifecycle-gap',fromSequence:consumed+1,toSequence:latest-64});consumed=latest-64;}
  while(consumed<latest){
   const sequence=consumed+1,v=FS.readFile(directory+`lifecycle-${sequence%64}.txt`,{encoding:'utf8'}).replace(/\0/g,'').split('|').map(Number);
   if(v.length!==10||v.some(n=>!Number.isFinite(n))||v[0]!==sequence)return;
   const [,localActionId,phase,action,plotIndex,dmap,screen,x,y,direction]=v;if(!phaseNames[phase]||!actionNames[action])return;
   send({type:'charmville:action-lifecycle',sequence,localActionId,phase:phaseNames[phase],action:actionNames[action],plotIndex,dmap,screen,x,y,direction});consumed=sequence;
  }
 }catch(error){console.warn('Native resource bridge unavailable',error.message);}
}
const timer=setInterval(poll,100);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
