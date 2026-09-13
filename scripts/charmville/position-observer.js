// Latest position is a client observation, never accepted movement authority.
const origins=['http://localhost:3017','http://127.0.0.1:3017'];
let run=null,lastSequence=0,lastCorrection=0,sessionId=crypto.randomUUID();
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.includes(event.origin)||typeof FS==='undefined')return;
 const c=event.data;
 if(!c||c.type!=='charmville:position-correction'||c.sessionId!==sessionId||!Number.isSafeInteger(c.sequence)||c.sequence<=lastCorrection)return;
 if(c.dmap!==4||c.screen!==63||!['spawn','rejected'].includes(c.reason)||![0,1,2,3].includes(c.direction))return;
 if(!Number.isInteger(c.x)||!Number.isInteger(c.y)||c.x<0||c.x>240||c.y<0||c.y>160||c.x%8||c.y%8)return;
 try{FS.writeFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/position-correction.txt',[c.sequence,c.dmap,c.screen,c.x,c.y,c.direction].join('|'));lastCorrection=c.sequence;}catch{}
});
function poll(){
 if(typeof FS==='undefined'||parent===window)return;
 try{
  const root=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
  if(!FS.analyzePath(root+'position.txt').exists||!FS.analyzePath(root+'action-run.txt').exists)return;
  const generation=Number(FS.readFile(root+'action-run.txt',{encoding:'utf8'}).replace(/\0/g,''));
  if(!Number.isSafeInteger(generation)||generation<1)return;
  if(run!==generation){run=generation;lastSequence=0;lastCorrection=0;sessionId=crypto.randomUUID();}
  const values=FS.readFile(root+'position.txt',{encoding:'utf8'}).replace(/\0/g,'').split('|').map(Number);
  if(values.length!==9||values.some(n=>!Number.isFinite(n)))return;
  const [sequence,dmap,screen,x,y,direction,z,fakeZ,appliedCorrectionSequence]=values;
  if(!Number.isSafeInteger(sequence)||sequence<=lastSequence||![0,1,2,3].includes(direction))return;
  lastSequence=sequence;
  const observation={type:'charmville:position-observed',sessionId,sequence,dmap,screen,x,y,direction,z,fakeZ,appliedCorrectionSequence,authority:'local-observation'};
  for(const origin of origins)parent.postMessage(observation,origin);
 }catch{/* Optional latest sample may be absent while native runtime starts. */}
}
const timer=setInterval(poll,100);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
