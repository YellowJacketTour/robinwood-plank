// Server-filtered parent projection; the native guest relay is a separate mode.
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
let peers=[],expires=0,last=null;
function flush(){
 if(parent===window||typeof FS==='undefined')return;
 if(Date.now()>expires)peers=[];
 const text=[1,peers.length,...peers.flatMap(p=>[p.x,p.y])].join('|');
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
 peers=data.active?data.peers:[];expires=Date.now()+6500;flush();
});
const timer=setInterval(flush,250);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
