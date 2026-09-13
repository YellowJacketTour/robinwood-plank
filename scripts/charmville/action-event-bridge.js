// Contact observations only: this bridge cannot grant or import rewards.
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
const actions={0:'till',1:'plant',2:'water',4:'harvest',5:'fertilize'};
let sessionId=crypto.randomUUID(),consumed=0,run=null;
function send(data){
  if(parent===window)return;
  for(const origin of origins)parent.postMessage({...data,sessionId},origin);
}
function poll(){
  if(typeof FS==='undefined')return;
  try{
    const directory=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville';
    if(!FS.analyzePath(directory+'/action-sequence.txt').exists)return;
    const generation=Number(FS.readFile(directory+'/action-run.txt',{encoding:'utf8'}).replace(/\0/g,''));
    if(!Number.isSafeInteger(generation)||generation<1)return;
    if(run!==null&&run!==generation){sessionId=crypto.randomUUID();consumed=0;send({type:'charmville:action-stream-reset'});}
    run=generation;
    const latest=Number(FS.readFile(directory+'/action-sequence.txt',{encoding:'utf8'}).replace(/\0/g,''));
    if(!Number.isSafeInteger(latest)||latest<0)return;
    if(latest<consumed){sessionId=crypto.randomUUID();send({type:'charmville:action-stream-reset'});consumed=0;}
    if(latest-consumed>64){send({type:'charmville:action-stream-gap',fromSequence:consumed+1,toSequence:latest-64});consumed=latest-64;}
    while(consumed<latest){
      const sequence=consumed+1;
      const values=FS.readFile(directory+`/action-${sequence%64}.txt`,{encoding:'utf8'}).replace(/\0/g,'').split('|').map(Number);
      if(values.length!==8||values.some(n=>!Number.isFinite(n))||values[0]!==sequence)return;
      const [,action,plotIndex,dmap,screen,x,y,direction]=values;
      if(!actions[action]||!Number.isInteger(plotIndex)||plotIndex<0||plotIndex>2)return;
      send({type:'charmville:action-contact',eventId:`${sessionId}:${sequence}`,sequence,action:actions[action],plotIndex,dmap,screen,x,y,direction,authority:'local-observation'});
      consumed=sequence;
    }
  }catch(error){console.warn('Charmville contact outbox could not be read',error.message);}
}
const timer=setInterval(poll,150);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
