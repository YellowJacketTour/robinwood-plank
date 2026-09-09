// Read-only server encounter presentation. No commands, hits or rewards.
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
let current=null,version=1,written=0,expires=0,effect=0,damage=0;
const seen=new Set();
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.has(event.origin))return;
 const data=event.data;if(data?.type!=='charmville:world-encounter'||typeof data.active!=='boolean')return;
 if(!data.active){current=null;seen.clear();damage=0;version++;return;}
 const e=data.encounter;
 if(!e||typeof e.id!=='string'||e.id.length>80||e.speciesId!==286||!/^\d{1,18}$/.test(String(e.revision))||!Number.isInteger(e.cell?.x)||!Number.isInteger(e.cell?.y)||e.cell.x<0||e.cell.x>30||e.cell.y<0||e.cell.y>20||!Number.isInteger(e.hp)||!Number.isInteger(e.maxHp)||e.maxHp<1||e.maxHp>10000||e.hp<0||e.hp>e.maxHp)return;
 if(current?.id===e.id&&BigInt(e.revision)<BigInt(current.revision))return;
 const same=current?.id===e.id;
 if(!same)seen.clear();
 const hit=data.damageEvent;
 if(hit&&typeof hit.eventId==='string'&&hit.eventId.length<=100&&Number.isInteger(hit.damage)&&hit.damage>0&&hit.damage<=10000&&!seen.has(hit.eventId)){
  if(same&&BigInt(e.revision)>BigInt(current.revision)){effect++;damage=hit.damage;}
  seen.add(hit.eventId);if(seen.size>128)seen.delete(seen.values().next().value);
 }
 current=e;expires=Date.now()+6500;version++;
});
function flush(){
 if(parent===window||typeof FS==='undefined')return;
 if(current&&Date.now()>expires){current=null;version++;}
 if(written===version)return;
 try{const path=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';FS.mkdirTree(path);FS.writeFile(path+'world-encounter.txt',[version,current?1:0,current?.cell.x||0,current?.cell.y||0,current?.hp||0,current?.maxHp||1,effect,damage].join('|'));written=version;}catch{}
}
const timer=setInterval(flush,100);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
