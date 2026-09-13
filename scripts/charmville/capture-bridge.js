// Receipt-only cosmetic playback. No capture calculation or inventory mutation.
const captureOrigins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
let captureSequence=0,captureInitialized=false,captureBusy=false,captureQueue=[],captureClear=false;const captureSeen=new Set();
const captureCell=c=>c&&Number.isInteger(c.x)&&Number.isInteger(c.y)&&c.x>=0&&c.x<=30&&c.y>=0&&c.y<=20;
window.addEventListener('message',event=>{
 if(event.source!==parent||!captureOrigins.has(event.origin))return;const e=event.data;if(e?.type!=='charmville:capture-event')return;
 if(e.active===false){captureQueue=[];captureBusy=false;captureSequence++;captureClear=true;return;}
 if(typeof e.eventId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.eventId)||!captureCell(e.actorCell)||!captureCell(e.targetCell)||typeof e.captured!=='boolean'||!Number.isInteger(e.shakes)||e.shakes<0||e.shakes>4||e.captured!==(e.shakes===4)||captureSeen.has(e.eventId))return;
 if(captureQueue.length>=8)return;captureSeen.add(e.eventId);if(captureSeen.size>128)captureSeen.delete(captureSeen.values().next().value);captureQueue.push(e);
});
const captureTimer=setInterval(()=>{if(parent===window||typeof FS==='undefined')return;const base='/Files/Homestead/charmville/';try{
 FS.mkdirTree(base);if(!captureInitialized){FS.writeFile(base+'capture-event.txt','0|0|0|0|0|0|0|0');FS.writeFile(base+'capture-ack.txt','0');captureInitialized=true;}
 if(captureClear){FS.writeFile(base+'capture-event.txt',[captureSequence,0,0,0,0,0,0,0].join('|'));captureClear=false;}
 if(captureBusy&&FS.analyzePath(base+'capture-ack.txt').exists&&Number(FS.readFile(base+'capture-ack.txt',{encoding:'utf8'}).replace(/\0/g,''))===captureSequence)captureBusy=false;
 if(!captureBusy&&captureQueue.length){const e=captureQueue.shift();captureSequence++;captureBusy=true;FS.writeFile(base+'capture-event.txt',[captureSequence,1,e.actorCell.x,e.actorCell.y,e.targetCell.x,e.targetCell.y,e.captured?1:0,Math.min(e.shakes,3)].join('|'));}
 }catch{/* Runtime not ready; retain receipt queue until available. */}},100);
window.addEventListener('pagehide',()=>clearInterval(captureTimer),{once:true});
