// Latest position is a client observation, never accepted movement authority.
const origins=['http://localhost:3017','http://127.0.0.1:3017'];
let run=null,lastSequence=0,lastCorrection=0,sessionId=crypto.randomUUID();
// Embedded account play is revealed only after the native script acknowledges
// its authoritative placement. Standalone Homestead waits for authored placement.
const standaloneArrival=parent===window&&(new URLSearchParams(location.search).get('test')||'').includes('/homestead-region/');
let arrivalPending=parent!==window||standaloneArrival;
let arrivalStarted=0,arrivalFailed=false;
function presentArrival(pending){
 arrivalPending=pending;
 if(typeof document==='undefined')return;
 document.body?.classList.toggle('charm-arrival-pending',pending);
 let notice=document.getElementById('charm-arrival-status');
 if(pending&&!notice){notice=document.createElement('p');notice.id='charm-arrival-status';notice.setAttribute('role','status');notice.textContent=standaloneArrival&&!arrivalStarted?'Choose Enter the world to begin.':'Preparing your place in the world…';document.querySelector('header')?.after(notice);}
 if(notice)notice.hidden=!pending;
}
presentArrival(arrivalPending);
function observeStandaloneArrival(position){
 if(!standaloneArrival||!arrivalPending)return;
 // A run-bound native receipt survives movement between browser samples.
 // Older packages without this protocol retain their coordinate fallback.
 const root=typeof FS==='undefined'?null:FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
 const hasReceipt=root&&FS.analyzePath(root+'arrival-ready.txt').exists;
 const ready=hasReceipt?Number(FS.readFile(root+'arrival-ready.txt',{encoding:'utf8'}).replace(/\0/g,''))===run:
  position.dmap===4&&position.screen===63&&position.x===16&&position.y===72&&position.z===0&&position.fakeZ===0;
 if(run!==null&&ready){presentArrival(false);arrivalFailed=false;return;}
 if(arrivalStarted&&Date.now()-arrivalStarted>15000&&!arrivalFailed){
  arrivalFailed=true;
  const notice=document.getElementById('charm-arrival-status');
  if(notice){notice.textContent='Your starting place did not finish loading. ';
   const retry=document.createElement('button');retry.type='button';retry.textContent='Reload world';retry.addEventListener('click',()=>location.reload());notice.append(retry);}
 }
}
document.addEventListener('click',event=>{
 if(standaloneArrival&&event.target?.closest?.('button.charm-runtime-enter')){
  arrivalStarted=Date.now();
  const notice=document.getElementById('charm-arrival-status');
  if(notice)notice.textContent='Preparing your place in the world…';
 }
},true);
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.includes(event.origin)||typeof FS==='undefined')return;
 const c=event.data;
 if(!c||c.type!=='charmville:position-correction'||c.sessionId!==sessionId||!Number.isSafeInteger(c.sequence)||c.sequence<=lastCorrection)return;
 if(c.dmap!==4||![62,63].includes(c.screen)||!['spawn','rejected'].includes(c.reason)||![0,1,2,3].includes(c.direction))return;
 if(!Number.isInteger(c.x)||!Number.isInteger(c.y)||c.x<0||c.x>240||c.y<0||c.y>160||c.x%8||c.y%8)return;
 // A rejection corrects location, not a turn made since that sample. Arrival
 // still has explicit facing; old six-field files retain that behavior.
 try{FS.writeFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/position-correction.txt',[c.sequence,c.dmap,c.screen,c.x,c.y,c.direction,c.reason==='rejected'?1:0].join('|'));lastCorrection=c.sequence;}catch{}
});
function poll(){
 if(typeof FS==='undefined'||(parent===window&&!standaloneArrival))return;
 try{
  const root=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';
  if(!FS.analyzePath(root+'position.txt').exists||!FS.analyzePath(root+'action-run.txt').exists)return;
  const generation=Number(FS.readFile(root+'action-run.txt',{encoding:'utf8'}).replace(/\0/g,''));
  if(!Number.isSafeInteger(generation)||generation<1)return;
  if(run!==generation){run=generation;lastSequence=0;lastCorrection=0;sessionId=crypto.randomUUID();arrivalStarted=Date.now();arrivalFailed=false;presentArrival(parent!==window||standaloneArrival);}
  observeStandaloneArrival({});
  const latest=FS.readFile(root+'position.txt',{encoding:'utf8'}).replace(/\0/g,'');
  const latestSequence=Number(latest.split('|',1)[0]);
  if(!Number.isSafeInteger(latestSequence)||latestSequence<=lastSequence)return;
  // Catch up only from recorded frames. A missing/overwritten ring falls back
  // to the latest observation, leaving discontinuity checks to the authority.
  const samples=[];
  if(lastSequence>0&&latestSequence-lastSequence<=64){
   for(let sequence=lastSequence+1;sequence<latestSequence;sequence++){
    const path=root+'position-'+(sequence%64)+'.txt';
    if(!FS.analyzePath(path).exists){samples.length=0;break;}
    const sample=FS.readFile(path,{encoding:'utf8'}).replace(/\0/g,'');
    if(Number(sample.split('|',1)[0])!==sequence){samples.length=0;break;}
    samples.push(sample);
   }
  }
  samples.push(latest);
  for(const sample of samples){
  const values=sample.split('|').map(Number);
  if(![9,12].includes(values.length)||values.some(n=>!Number.isFinite(n)))return;
  let [sequence,dmap,screen,x,y,direction,z,fakeZ,appliedCorrectionSequence]=values;
  let region;
  if(values.length===12){
   const [map,width,height]=values.slice(9);
   if(!Number.isInteger(map)||map<1||!Number.isInteger(screen)||screen<0||screen>=128||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||screen%16+width>16||Math.floor(screen/16)+height>8||x<0||y<0||x>=width*256||y>=height*176)return;
   // Origin identifies the loaded rectangle, not the hero's containing room.
   // Preserve native coordinates for future region admission; legacy consumers
   // still receive source-screen-local coordinates and keep their own authority.
   region={map,origin:screen,width,height,x,y};
   screen+=Math.floor(x/256)+Math.floor(y/176)*16;
   x%=256;y%=176;
  }
  if(!Number.isSafeInteger(sequence)||sequence<=lastSequence||![0,1,2,3].includes(direction))return;
  lastSequence=sequence;
  if(arrivalPending&&lastCorrection>0&&appliedCorrectionSequence>=lastCorrection)presentArrival(false);
  const observation={type:'charmville:position-observed',sessionId,sequence,dmap,screen,x,y,direction,z,fakeZ,appliedCorrectionSequence,authority:'local-observation'};
  if(region)observation.region=region;
  observeStandaloneArrival(observation);
  if(parent!==window)for(const origin of origins)parent.postMessage(observation,origin);
  }
 }catch{/* Optional latest sample may be absent while native runtime starts. */}
}
// Observe native frames frequently enough to retain adjacent 8px cells while
// walking. Unchanged native sequence numbers are ignored above.
const timer=setInterval(poll,16);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
