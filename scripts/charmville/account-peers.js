// Server-filtered parent projection; the native guest relay is a separate mode.
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
let peers=[],expires=0,last=null;
function rendered(peer,now){const t=Math.min(1,Math.max(0,(now-peer.started)/100));return {x:Math.round(peer.fromX+(peer.x-peer.fromX)*t),y:Math.round(peer.fromY+(peer.y-peer.fromY)*t)};}
function flush(){
 if(parent===window||typeof FS==='undefined')return;
 if(Date.now()>expires)peers=[];
 const text=[1,peers.length,...peers.flatMap(p=>{const point=rendered(p,Date.now());return [point.x,point.y];}),...peers.map(p=>p.direction)].join('|');
 if(text===last)return;
 try{const root=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville';FS.mkdirTree(root);FS.writeFile(root+'/account-peers.txt',text);last=text;}catch{}
}
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.has(event.origin))return;
 const data=event.data;if(!data||data.type!=='charmville:account-peers'||typeof data.active!=='boolean'||!Array.isArray(data.peers)||data.peers.length>16)return;
 const ids=new Set();
 for(const p of data.peers){
  if(!p||typeof p.profileId!=='string'||p.profileId.length<1||p.profileId.length>128||ids.has(p.profileId)||typeof p.handle!=='string'||p.handle.length>128)return;
  if(!Number.isInteger(p.x)||!Number.isInteger(p.y)||p.x<0||p.x>240||p.y<0||p.y>160||p.x%8||p.y%8)return;ids.add(p.profileId);
 }
 const now=Date.now();
 const previous=new Map((now>expires?[]:peers).map(p=>[p.profileId,p]));
 peers=data.active?data.peers.map(p=>{
  const old=previous.get(p.profileId);let direction=old?.direction??1;
  if(old){const dx=p.x-old.x,dy=p.y-old.y;if(Math.abs(dx)>Math.abs(dy))direction=dx<0?2:3;else if(dy!==0)direction=dy<0?0:1;}
  if(old&&old.x===p.x&&old.y===p.y)return {...old,handle:p.handle};
  const smooth=old&&Math.abs(p.x-old.x)<=8&&Math.abs(p.y-old.y)<=8;
  const from=smooth?rendered(old,now):p;
  return {...p,direction,fromX:from.x,fromY:from.y,started:now};
 }):[];expires=Date.now()+6500;flush();
});
const timer=setInterval(flush,25);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
