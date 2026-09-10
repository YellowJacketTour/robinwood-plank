import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const out='work/native-party-projection';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
async function verify(){
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
 if(process.argv.includes('--defeat')){
  await runtime.evaluate(()=>{const write=FS.writeFile.bind(FS);window.fixtureWriteEncounter=text=>write('/Files/Homestead/charmville/world-encounter.txt',text);FS.writeFile=(path,...args)=>path.endsWith('/world-encounter.txt')?undefined:write(path,...args);});
  const emit=async(seq,active,hp)=>runtime.evaluate(({seq,active,hp})=>window.fixtureWriteEncounter([seq,active,8,9,hp,13,0,0,0,0,0,0].join('|')),{seq,active,hp});
  await emit(100,1,0);await page.waitForTimeout(300);assert(!events.includes('CHARMVILLE_DEFEAT_START'));
  await emit(101,1,5);await page.waitForTimeout(250);await emit(102,1,0);await page.waitForTimeout(140);await page.screenshot({path:out+'/defeat-falling.png'});await page.waitForTimeout(500);await page.screenshot({path:out+'/defeat-held.png'});await page.waitForTimeout(600);await page.screenshot({path:out+'/defeat-finished.png'});
  assert.equal(events.filter(e=>e==='CHARMVILLE_DEFEAT_START').length,1);assert(events.includes('CHARMVILLE_DEFEAT_COMPLETE'));await emit(103,1,0);await page.waitForTimeout(200);assert.equal(events.filter(e=>e==='CHARMVILLE_DEFEAT_START').length,1);
  await emit(104,1,5);await page.waitForTimeout(100);await emit(105,0,0);await page.waitForTimeout(200);assert.equal(events.filter(e=>e==='CHARMVILLE_DEFEAT_START').length,1);
  await writeFile(out+'/defeat.json',JSON.stringify({scope:'Synthetic native snapshot transitions, not a server defeat/reward test.',events,errors},null,2));assert.deepEqual(errors,[]);console.log('Native defeat source transition, terminal hiding, duplicate baseline and captured/off behavior pass.');
 }else if(process.argv.includes('--capture-visual')){
  for(const [won,shakes] of [[false,2],[true,4]]){
   const eventId=randomUUID();await page.evaluate(data=>document.querySelector('iframe').contentWindow.postMessage(data,'http://localhost:3021'),{type:'charmville:capture-event',eventId,actorCell:{x:2,y:9},targetCell:{x:8,y:9},captured:won,shakes});
   await page.waitForTimeout(220);await page.screenshot({path:out+`/capture-${won}-throw.png`});
   await page.waitForTimeout(250);await page.screenshot({path:out+`/capture-${won}-open.png`});
   await page.waitForTimeout(650);await page.screenshot({path:out+`/capture-${won}-shake.png`});
   await page.waitForTimeout(1700);
   assert(events.some(e=>e.startsWith('CHARMVILLE_CAPTURE_RESULT ')&&e.endsWith(`WON ${won?1:0}`)));
  }
  await writeFile(out+'/capture-visual.json',JSON.stringify({scope:'Synthetic committed-outcome presentation snapshots. Timed screenshots, not exact frame assertions. Actual server receipts verified separately.',events,errors},null,2));assert.deepEqual(errors,[]);console.log('Capture source presentation sampled for release and success.');
 }else if(process.argv.includes('--attack-directions')){
  // Isolate presentation fixture from the unadmitted parent's periodic clear.
  // This is not a committed account battle or ownership verification.
  await runtime.evaluate(()=>{const write=FS.writeFile.bind(FS);window.fixtureWriteEncounter=text=>write('/Files/Homestead/charmville/world-encounter.txt',text);FS.writeFile=(path,...args)=>{if(path.endsWith('/world-encounter.txt'))return;return write(path,...args);};});
  const emit=async(revision,hit)=>runtime.evaluate(({revision,hit})=>window.fixtureWriteEncounter([revision,1,4,9,9,13,revision-1,hit?1:0,hit?.actorSpeciesId||0,hit?.actorCell.x||0,hit?.actorCell.y||0,0].join('|')),{revision,hit});
  await emit(1,null);await page.waitForTimeout(350);let sequence=1;
  for(const [species,move] of [[25,98],[133,33],[286,33]])for(const [row,x,y] of [[0,4,7],[1,2,7],[2,2,9],[3,2,11],[4,4,11],[5,6,11],[6,6,9],[7,6,7]]){
   sequence++;const marker=`CHARMVILLE_ATTACK_CONTACT ${species} ROW ${row}`;
   await emit(sequence,{eventId:String(sequence),damage:1,actorId:'fixture-actor',actorSpeciesId:species,moveId:move,actorCell:{x,y}});
   await page.waitForTimeout(120);await page.screenshot({path:out+`/attack-${species}-${row}.png`});
   const deadline=Date.now()+3500;while(!events.includes(marker)&&Date.now()<deadline)await page.waitForTimeout(50);if(!events.includes(marker))await writeFile(out+"/attack-failure.json",JSON.stringify({events,fs:await runtime.evaluate(()=>FS.readFile("/Files/Homestead/charmville/world-encounter.txt",{encoding:"utf8"}))},null,2));assert(events.includes(marker),marker);
   await page.waitForTimeout(450);
  }
  await writeFile(out+'/attack-directions.json',JSON.stringify({scope:'Synthetic native FS presentation (JS bridge writes isolated): three added species, eight facings. Screenshots sampled at elapsed time, not exact contact tick; no battle ownership proof.',events,errors},null,2));assert.deepEqual(errors,[]);console.log('Three added species emitted source contact in all eight native directions.');
 }else if(process.argv.includes('--resources')){
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
 const species=[277,280,283,25,133,286];
 await page.evaluate(speciesIds=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds},'http://localhost:3021'),species);
 await page.waitForTimeout(800);
 async function move(key,ms){await page.keyboard.down(key);await page.waitForTimeout(ms);await page.keyboard.up(key);await page.waitForTimeout(200);}
 if(!process.argv.includes('--spawn')){await move('ArrowDown',500);await move('ArrowRight',1500);await move('ArrowUp',450);await move('ArrowLeft',350);}
 for(let i=0;i<6;i++)assert(events.includes(`CHARMVILLE_PARTY_DRAW ${i} ${species[i]}`),`Slot ${i} must draw`);
 await page.screenshot({fullPage:true,path:out+'/six-followers.png'});
 if(process.argv.includes('--spawn')){
  await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds:[25,133]},'http://localhost:3021'));await page.waitForTimeout(600);
  assert(events.includes('CHARMVILLE_PARTY_DRAW 0 25'));assert(events.includes('CHARMVILLE_PARTY_DRAW 1 133'));
  await page.screenshot({fullPage:true,path:out+'/two-followers-spawn.png'});
  await writeFile(out+'/spawn.json',JSON.stringify({scope:'Read-only six then two species projection at stationary native spawn; not account roster ownership.',events,errors},null,2));assert.deepEqual(errors,[]);console.log('Six and two native companions visible before any directional input.');process.exitCode=0;return;
 }
 const path='/Files/Homestead/charmville/party-followers.txt';
 assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),[...species,18].join('|'));
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds:[277,280,283,277,280,283,277]},'http://localhost:3021'));
 await page.waitForTimeout(500);assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),[...species,18].join('|'));
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:follower-formation',formation:'relaxed'},'http://localhost:3021'));
 await move('ArrowLeft',900);await page.screenshot({fullPage:true,path:out+'/six-followers-relaxed.png'});assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),[...species,26].join('|'));
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'charmville:party-followers',speciesIds:[]},'http://localhost:3021'));
 await page.waitForTimeout(600);assert.equal(await runtime.evaluate(path=>FS.readFile(path,{encoding:'utf8'}),path),'0|0|0|0|0|0|26');
 assert.deepEqual(errors,[]);await writeFile(out+'/verification.json',JSON.stringify({scope:'Synthetic six-member presentation projection; does not establish account ownership of six creatures.',events,errors},null,2));
 console.log('Six synthetic native projection slots rendered; oversized party rejected; clearing works.');
 }
}catch(error){await writeFile(out+'/failure.txt',String(error));const last=browser.contexts()[0]?.pages()[0];if(last)await last.screenshot({path:out+'/failure.png'});throw error;}finally{await browser.close();}
}
await verify();
