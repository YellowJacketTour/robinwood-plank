import {chromium} from 'playwright';import {adventureUrl} from './adventure-entry.mjs';import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const out=process.argv[2]||'.charmville-homestead-check';await mkdir(out,{recursive:true});
const b=await chromium.launch({args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
try{
 const records=[];
 for(let i=0;i<2;i++){
  const p=await b.newPage({viewport:{width:1280,height:900}}),sent=[],received=[],errors=[];
  p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>{ws.on('framesent',f=>sent.push(String(f.payload)));ws.on('framereceived',f=>received.push(String(f.payload)));});
  const url=new URL(adventureUrl(),'http://localhost:3021');url.searchParams.set('test','/quests/charmville/homestead/r01/Homestead.qst');await p.goto(url.href);await p.getByRole('button',{name:'Enter the world',exact:true}).click();await p.waitForTimeout(11000);
  async function tap(key){await p.keyboard.down(key);await p.waitForTimeout(150);await p.keyboard.up(key);await p.waitForTimeout(200);}
  for(let n=0;n<3;n++)await tap('d');await p.waitForTimeout(5300);await tap('d');await tap('c');await p.waitForTimeout(600);
  await p.screenshot({path:out+'/player-'+i+'.png'});records.push({p,sent,received,errors});
 }
 const [a]=records;await a.p.bringToFront();await a.p.keyboard.down('ArrowLeft');await a.p.waitForTimeout(350);await a.p.keyboard.up('ArrowLeft');await a.p.waitForTimeout(1300);await a.p.screenshot({path:out+'/shared-meadow.png'});
 const result=records.map(r=>({errors:r.errors,sent:r.sent.length,received:r.received.length,joined:r.sent.some(s=>s.split('|')[9]==='1'),aura:r.sent.some(s=>s.split('|')[10]==='1'),peers:r.received.filter(s=>s.startsWith('peer|')).length,last:r.sent.slice(-2)}));await writeFile(out+'/verification.json',JSON.stringify(result,null,2));console.log(result);for(const r of result){assert.deepEqual(r.errors,[]);assert(r.joined&&r.aura&&r.peers>0);}
}finally{await b.close()}
