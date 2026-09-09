import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://localhost:3017',out='work/native-resource-replication';
await mkdir(out,{recursive:true});
const browser=await chromium.launch(),evidence=[],diagnostics=[];
try {
 const players=[];
 for(let i=0;i<2;i++) {
  const context=await browser.newContext({viewport:{width:1100,height:1050}}),page=await context.newPage();
  page.on('crash',()=>diagnostics.push({player:i,event:'crash',at:Date.now()}));page.on('framedetached',frame=>diagnostics.push({player:i,event:'detached',url:frame.url(),at:Date.now()}));page.on('pageerror',error=>diagnostics.push({player:i,event:'error',message:error.message,at:Date.now()}));
  const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(response.status(),200);
  const user=await response.json(),headers={Origin:base,authorization:`Bearer ${user.token}`};
  const api=async(path,data)=>{const r=data===undefined?await page.request.get(base+path,{headers}):await page.request.post(base+path,{headers,data});assert.equal(r.status(),200,`${path}: ${await r.text()}`);return r.json();};
  let presence=await api('/api/charmville/world/presence');await api('/api/charmville/world/presence',{destination:'public',revision:presence.revision});
  await api('/api/charmville/world/actor');await api('/api/charmville/world/resources');
  await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);
  players.push({page,user,api});
 }
 const [owner,visitor]=players;
 await owner.api(`/api/charmville/${owner.user.handle}/access`,{visitor:visitor.user.handle,revoke:false,rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString(),revision:'0'});
 await new Promise(r=>setTimeout(r,1100));
 for(const p of players){const presence=await p.api('/api/charmville/world/presence');await p.api('/api/charmville/world/presence',{destination:'home',handle:owner.user.handle,revision:presence.revision});await p.api('/api/charmville/world/actor');}
 await Promise.all(players.map(async p=>{await p.page.goto(base+'/charmville/world?panel=play');await p.page.locator('iframe').waitFor();await p.page.frameLocator('iframe').getByRole('button',{name:'Enter the world',exact:true}).click();}));
 await owner.page.waitForTimeout(12000);
 const tap=async p=>{await p.page.keyboard.down('d');await p.page.waitForTimeout(150);await p.page.keyboard.up('d');await p.page.waitForTimeout(1200);};
 for(const p of players){await tap(p);await tap(p);p.runtime=p.page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(p.runtime);}
 const observe=async(stage,label)=>{
  let states,files;
  for(let attempt=0;attempt<30;attempt++){
   states=await Promise.all(players.map(p=>p.api('/api/charmville/world/resources')));
   files=await Promise.all(players.map(p=>p.runtime.evaluate(()=>FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/resource-state.txt',{encoding:'utf8'}))));
   if(states.every(s=>s.beds[0].stage===stage)&&files.every(f=>Number(f.split('|')[5])===stage))break;
   await owner.page.waitForTimeout(500);
  }
  evidence.push({label,states,files});await writeFile(out+'/result.json',JSON.stringify(evidence,null,2));
  assert.equal(states[0].regionId,states[1].regionId);
  for(let i=0;i<2;i++){assert.equal(states[i].beds[0].stage,stage,label);assert.equal(Number(files[i].split('|')[5]),stage,`${label} native projection ${i}`);await players[i].page.screenshot({fullPage:true,path:`${out}/${label}-${i===0?'owner':'visitor'}.png`});}
  assert.equal(states[1].seeds,'3');assert.equal(states[1].produce,'0');
  return states;
 };
 await observe(0,'unworked');
 for(const [stage,label] of [[1,'tilled'],[2,'planted'],[3,'watered']]){await tap(owner);await observe(stage,label);}
 await owner.page.waitForTimeout(31000);await observe(4,'ripe');
 await tap(owner);const final=await observe(1,'harvested');assert.equal(final[0].produce,'1');assert.equal(final[0].seeds,'3');
 console.log('Two actual accounts: native owner lifecycle replicated to visitor; visitor balances unchanged.');
} finally {await writeFile(out+'/diagnostics.json',JSON.stringify(diagnostics,null,2));await browser.close();}

