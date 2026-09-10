// Read-only server encounter presentation. No commands, hits or rewards.
const origins=new Set(['http://localhost:3017','http://127.0.0.1:3017']);
let current=null,version=1,written=0,expires=0,effect=0,damage=0,attack=null,generation=0;
let queue=[],lastEvent=0n,busy=false,initialized=false;
window.addEventListener('message',event=>{
 if(event.source!==parent||!origins.has(event.origin))return;
 const data=event.data;if(data?.type!=='charmville:world-encounter'||typeof data.active!=='boolean')return;
 if(!data.active){if(current)generation++;current=null;queue=[];lastEvent=0n;busy=false;attack=null;damage=0;version++;return;}
 const e=data.encounter;
 if(!e||typeof e.id!=='string'||e.id.length>80||e.speciesId!==286||!/^\d{1,18}$/.test(String(e.revision))||!Number.isInteger(e.cell?.x)||!Number.isInteger(e.cell?.y)||e.cell.x<0||e.cell.x>30||e.cell.y<0||e.cell.y>20||!Number.isInteger(e.hp)||!Number.isInteger(e.maxHp)||e.maxHp<1||e.maxHp>10000||e.hp<0||e.hp>e.maxHp)return;
 if(current?.id===e.id&&BigInt(e.revision)<BigInt(current.revision))return;
 const same=current?.id===e.id;
 if(!same){generation++;queue=[];lastEvent=0n;busy=false;attack=null;damage=0;}
 const hits=(Array.isArray(data.damageEvents)?data.damageEvents.slice(0,16):[data.damageEvent]).filter(hit=>hit&&/^\d{1,18}$/.test(hit.eventId)&&Number.isInteger(hit.damage)&&hit.damage>0&&hit.damage<=10000).sort((a,b)=>BigInt(a.eventId)<BigInt(b.eventId)?-1:1);
 for(const hit of hits){
  if(BigInt(hit.eventId)<=lastEvent)continue;
  if(same&&BigInt(e.revision)>BigInt(current.revision)){
   if(queue.length<64)queue.push(hit);else console.warn('Encounter presentation queue overflow; refresh state');
  }
  lastEvent=BigInt(hit.eventId);
 }
 current=e;expires=Date.now()+6500;version++;
});
function flush(){
 if(parent===window||typeof FS==='undefined')return;
 if(current&&Date.now()>expires){current=null;queue=[];busy=false;attack=null;damage=0;generation++;version++;}
 try{const path=FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/';FS.mkdirTree(path);
  if(!initialized){for(const [file,index] of [['encounter-effect-ack.txt',0],['world-encounter.txt',6]])if(FS.analyzePath(path+file).exists){const previous=Number(FS.readFile(path+file,{encoding:'utf8'}).replace(/\0/g,'').split('|')[index]);if(Number.isSafeInteger(previous)&&previous>=0)effect=Math.max(effect,previous);}initialized=true;}
  if(busy&&FS.analyzePath(path+'encounter-effect-ack.txt').exists&&Number(FS.readFile(path+'encounter-effect-ack.txt',{encoding:'utf8'}).replace(/\0/g,''))===effect){busy=false;version++;}
  if(current&&!busy&&queue.length){const hit=queue.shift();effect++;damage=hit.damage;attack=null;busy=true;version++;const supported={277:1,280:10,283:33,25:98,133:33,286:33};if(typeof hit.actorId==='string'&&hit.actorId.length<=80&&supported[hit.actorSpeciesId]===hit.moveId&&Number.isInteger(hit.actorCell?.x)&&Number.isInteger(hit.actorCell?.y)&&hit.actorCell.x>=0&&hit.actorCell.x<=30&&hit.actorCell.y>=0&&hit.actorCell.y<=20)attack={species:hit.actorSpeciesId,x:hit.actorCell.x,y:hit.actorCell.y,slot:0};if(attack&&FS.analyzePath(path+"party-follower-ids.txt").exists){const ids=FS.readFile(path+"party-follower-ids.txt",{encoding:"utf8"}).split("|");attack.slot=ids.slice(0,6).indexOf(hit.actorId)+1;}}
  if(written!==version){FS.writeFile(path+'world-encounter.txt',[version,current?1:0,current?.cell.x||0,current?.cell.y||0,current?.hp||0,current?.maxHp||1,effect,damage,attack?.species||0,attack?.x||0,attack?.y||0,attack?.slot||0,generation,(busy||queue.length)?1:0].join('|'));written=version;}
 }catch{}
}
const timer=setInterval(flush,100);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
