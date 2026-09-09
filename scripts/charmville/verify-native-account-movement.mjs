import {chromium} from 'playwright';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const base='http://localhost:3017',out='work/native-account-movement';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});
 const r=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);const user=await r.json();
 const headers={Origin:base,authorization:`Bearer ${user.token}`};
 const initial=await(await page.request.get(base+'/api/charmville/world/presence',{headers})).json();
 assert.equal((await page.request.post(base+'/api/charmville/world/presence',{headers,data:{destination:'public',revision:initial.revision}})).status(),200);
 const bob=await(await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}})).json();
 const bobHeaders={Origin:base,authorization:`Bearer ${bob.token}`};
 const bobPresence=await(await page.request.get(base+'/api/charmville/world/presence',{headers:bobHeaders})).json();
 assert.equal((await page.request.post(base+'/api/charmville/world/presence',{headers:bobHeaders,data:{destination:'public',revision:bobPresence.revision}})).status(),200);
 const bobActor=await(await page.request.get(base+'/api/charmville/world/actor',{headers:bobHeaders})).json();
 await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});window.positions=[];window.addEventListener('message',e=>{if(e.data?.type==='charmville:position-observed')window.positions.push(e.data);});},user);
 await page.goto(base+'/charmville/world?panel=play');await page.getByRole('button',{name:'Open adventure camera',exact:true}).click();await page.frameLocator('iframe').getByRole('button',{name:'Enter the world',exact:true}).click();
 await page.waitForFunction(()=>window.positions.some(p=>p.appliedCorrectionSequence>0),{},{timeout:60000});
 const before=await(await page.request.get(base+'/api/charmville/world/actor',{headers})).json();
 await page.waitForTimeout(12000);
 // Native tutorial dialogue must be dismissed before movement.
 for(let i=0;i<2;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(800);}
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(700);await page.keyboard.up('ArrowRight');await page.waitForTimeout(500);
 const after=await(await page.request.get(base+'/api/charmville/world/actor',{headers})).json();
 const positions=await page.evaluate(()=>window.positions);await writeFile(out+'/result.json',JSON.stringify({before,after,positions},null,2));await page.screenshot({path:out+'/movement.png'});
 assert(after.sequence>before.sequence,'Actual native movement must reach persisted actor');
 assert.equal(after.profileId,before.profileId);
 assert(after.peers.some(p=>p.profileId===bobActor.profileId),'Authenticated peer must be visible');
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 const peerFile=await runtime.evaluate(()=>FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/account-peers.txt',{encoding:'utf8'}));
 const fields=peerFile.replace(/\0/g,'').split('|').map(Number);assert.equal(fields[0],1);assert(fields[1]>=1);
 assert(Array.from({length:fields[1]},(_,i)=>[fields[2+i*2],fields[3+i*2]]).some(([x,y])=>x===bobActor.cell.x*8&&y===bobActor.cell.y*8));
 console.log('Actual native movement saved to authenticated actor; observations and screenshot recorded.');
}finally{await browser.close();}
