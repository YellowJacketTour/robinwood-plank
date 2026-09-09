import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const out='work/native-party-projection';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1100,height:950}}),events=[],errors=[];
 await page.addInitScript(()=>{window.nativeLifecycle=[];window.addEventListener('message',event=>{if(event.origin==='http://localhost:3021'&&event.source===document.querySelector('iframe')?.contentWindow&&event.data?.type==='charmville:action-lifecycle')window.nativeLifecycle.push(event.data);});});
 await page.addInitScript(()=>{window.nativePositions=[];window.addEventListener('message',event=>{if(event.origin==='http://localhost:3021'&&event.source===document.querySelector('iframe')?.contentWindow&&event.data?.type==='charmville:position-observed')window.nativePositions.push({...event.data,receivedAt:performance.now()});});});
 await page.addInitScript(()=>{window.nativeContacts=[];window.observedContacts=[];window.addEventListener("charmville:local-contact-observed",event=>window.observedContacts.push(event.detail));window.addEventListener('message',event=>{if(event.origin==='http://localhost:3021'&&event.source===document.querySelector('iframe')?.contentWindow&&event.data?.type==='charmville:action-contact')window.nativeContacts.push(event.data);});});
 page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 // A guest account opens the normal parent UI; the six creatures below are
 // explicitly synthetic presentation data, not six owned account creatures.
 const base='http://localhost:3017';
 const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(response.status(),200);const user=await response.json();
 assert.equal((await page.request.post(`${base}/api/charmville/${user.handle}`,{headers:{Origin:base,authorization:`Bearer ${user.token}`},data:{action:'claim',requestId:randomUUID()}})).status(),200);
 await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);
 await page.goto(base+'/charmville/world?panel=play');

 await page.locator('iframe').waitFor({state:'attached'});
 await page.frameLocator('iframe').getByRole('button',{name:'Enter the world',exact:true}).click();
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 await page.waitForTimeout(12000);
 for(let i=0;i<2;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(800);}
 if(process.argv.includes('--resources')){
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:resource-state',active:true,beds:[0,1,2].map(id=>({id,stage:0,growthVisualPhase:0,allowedActions:['till','plant','water','harvest']})),seeds:3,produce:0},'http://localhost:3021'));
  await page.waitForTimeout(300);await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');
  await page.waitForFunction(()=>window.nativeLifecycle.some(e=>e.phase==='begin'));
  await page.waitForTimeout(650);assert(!(await page.evaluate(()=>window.nativeLifecycle)).some(e=>e.phase==='contact'),'No contact without authorization');
  await page.evaluate(()=>{const e=window.nativeLifecycle[0];document.querySelector('iframe').contentWindow.postMessage({type:'charmville:action-authorization',sessionId:e.sessionId,localActionId:e.localActionId,accepted:true},'http://localhost:3021');});
  await page.waitForFunction(()=>window.nativeLifecycle.some(e=>e.phase==='contact'));
  assert(!events.some(e=>e.startsWith('CHARMVILLE_CROP_STAGE')),'Authoritative action must not mutate local crop stage');
  await page.evaluate(()=>{const e=window.nativeLifecycle[0];document.querySelector('iframe').contentWindow.postMessage({type:'charmville:resource-state',active:true,sessionId:e.sessionId,resolvedLocalActionId:e.localActionId,beds:[0,1,2].map(id=>({id,stage:id===0?1:0,growthVisualPhase:0,allowedActions:['till','plant','water','harvest']})),seeds:3,produce:0},'http://localhost:3021');});
  await page.waitForTimeout(600);await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');
  await page.waitForFunction(()=>window.nativeLifecycle.filter(e=>e.phase==='begin').length===2);
  await page.evaluate(()=>{const e=window.nativeLifecycle.filter(e=>e.phase==='begin').at(-1);document.querySelector('iframe').contentWindow.postMessage({type:'charmville:action-authorization',sessionId:e.sessionId,localActionId:e.localActionId,accepted:false},'http://localhost:3021');});
  await page.waitForFunction(()=>window.nativeLifecycle.some(e=>e.phase==='cancel'));
  await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');
  await page.waitForFunction(()=>window.nativeLifecycle.filter(e=>e.phase==='begin').length===3);
  await page.evaluate(()=>{const p=window.nativePositions.at(-1);document.querySelector('iframe').contentWindow.postMessage({type:'charmville:position-correction',sessionId:p.sessionId,sequence:900,dmap:4,screen:63,x:16,y:72,direction:1,reason:'rejected'},'http://localhost:3021');});
  await page.waitForFunction(()=>window.nativeLifecycle.filter(e=>e.phase==='cancel').length===2);
  const lifecycle=await page.evaluate(()=>window.nativeLifecycle);assert.deepEqual(lifecycle.map(e=>e.phase),['begin','contact','begin','cancel','begin','cancel']);
  await writeFile(out+'/resources.json',JSON.stringify({scope:'Synthetic authorization/receipt projection, not server settlement proof.',lifecycle,events,errors},null,2));assert.deepEqual(errors,[]);
  console.log('Native waits for authorization, emits contact, uses receipt stage and cancels denied work.');
 }else if(process.argv.includes('--peers')){
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:account-peers',active:true,peers:[{profileId:'fixture-a',handle:'fixture-a',x:48,y:72},{profileId:'fixture-b',handle:'fixture-b',x:80,y:72}]},'http://localhost:3021'));
  await page.waitForTimeout(800);assert(events.includes('CHARMVILLE_ACCOUNT_PEERS 2'));
  await page.screenshot({path:out+'/peer-projection.png'});
  for(const [direction,x,y] of [[3,56,72],[0,56,64],[2,48,64],[1,48,72]]){
   await page.evaluate(({x,y})=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:account-peers',active:true,peers:[{profileId:'fixture-a',handle:'fixture-a',x,y},{profileId:'fixture-b',handle:'fixture-b',x:80,y:72}]},'http://localhost:3021'),{x,y});
   await page.waitForTimeout(400);assert(events.includes(`CHARMVILLE_PEER_FACING 0 DIR ${direction}`));await page.screenshot({path:out+`/peer-direction-${direction}.png`});
  }
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:account-peers',active:true,peers:[]},'http://localhost:3021'));
  await page.waitForTimeout(500);assert.equal(await runtime.evaluate(()=>FS.readFile('/Files/Homestead/charmville/account-peers.txt',{encoding:'utf8'})),'1|0');
  assert.deepEqual(errors,[]);console.log('Synthetic bounded peer projection and clearing verified; account ownership is tested separately.');
 }else if(process.argv.includes('--positions')){
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(600);await page.keyboard.up('ArrowRight');await page.waitForTimeout(300);
  const observations=await page.evaluate(()=>window.nativePositions);assert(observations.length>2);assert(observations.some(p=>p.x>24));
  await page.evaluate(()=>{const latest=window.nativePositions.at(-1);document.querySelector('iframe').contentWindow.postMessage({type:'charmville:position-correction',sessionId:latest.sessionId,sequence:900,dmap:4,screen:63,x:16,y:72,direction:1,reason:'rejected'},'http://localhost:3021');});
  await page.waitForFunction(()=>window.nativePositions.some(p=>p.appliedCorrectionSequence===900&&p.x===16&&p.y===72));
  await writeFile(out+'/positions.json',JSON.stringify({scope:'Native observation and guarded correction projection; not server-authorized movement evidence.',observations:await page.evaluate(()=>window.nativePositions),errors},null,2));
  assert.deepEqual(errors,[]);console.log('Native movement observations and correction acknowledgment verified.');
 }else if(process.argv.includes('--contacts')){
  for(let i=0;i<3;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(1050);}
  const contacts=await page.evaluate(()=>window.nativeContacts);
  assert.deepEqual(contacts.map(c=>c.action),['till','plant','water']);
  assert.deepEqual(contacts.map(c=>c.sequence),[1,2,3]);
  const observed=await page.evaluate(()=>window.observedContacts);assert.deepEqual(observed.map(o=>o.contact.eventId),contacts.map(c=>c.eventId));assert(observed.every(o=>o.gap===false));
  assert(contacts.every(c=>c.plotIndex===0&&c.authority==='local-observation'&&!('reward' in c)));
  await writeFile(out+'/contacts.json',JSON.stringify({contacts,events,errors},null,2));
  assert.deepEqual(errors,[]);console.log('Three actual native contact events reached the parent in sequence without reward authority.');
 }else{
 const species=[277,280,283,277,280,283];
 await page.evaluate(speciesIds=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds},'http://localhost:3021'),species);
 await page.waitForTimeout(800);
 async function move(key,ms){await page.keyboard.down(key);await page.waitForTimeout(ms);await page.keyboard.up(key);await page.waitForTimeout(200);}
 await move('ArrowDown',500);await move('ArrowRight',1500);await move('ArrowUp',450);await move('ArrowLeft',350);
 for(let i=0;i<6;i++)assert(events.includes(`CHARMVILLE_PARTY_DRAW ${i} ${species[i]}`),`Slot ${i} must draw`);
 await page.screenshot({path:out+'/six-followers.png'});
 const path='/Files/Homestead/charmville/party-followers.txt';
 assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),species.join('|'));
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds:[277,280,283,277,280,283,277]},'http://localhost:3021'));
 await page.waitForTimeout(500);assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),species.join('|'));
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds:[]},'http://localhost:3021'));
 await page.waitForTimeout(600);assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),'0|0|0|0|0|0');
 assert.deepEqual(errors,[]);await writeFile(out+'/verification.json',JSON.stringify({scope:'Synthetic six-member presentation projection; does not establish account ownership of six creatures.',events,errors},null,2));
 console.log('Six synthetic native projection slots rendered; oversized party rejected; clearing works.');
 }
}finally{await browser.close();}
