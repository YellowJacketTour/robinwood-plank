import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const out='work/native-party-projection';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1100,height:950}}),events=[],errors=[];
 page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 // A guest account opens the normal parent UI; the six creatures below are
 // explicitly synthetic presentation data, not six owned account creatures.
 const base='http://localhost:3017';
 const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(response.status(),200);const user=await response.json();
 assert.equal((await page.request.post(`${base}/api/charmville/${user.handle}`,{headers:{Origin:base,authorization:`Bearer ${user.token}`},data:{action:'claim',requestId:randomUUID()}})).status(),200);
 await page.addInitScript(({wallet,token})=>{for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state&&state.address!==wallet)e.stopImmediatePropagation();},true);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);
 await page.goto(base+'/charmville/world');
 await page.getByRole('tab',{name:'Play',exact:true}).click();
 await page.getByRole('button',{name:'Open adventure camera',exact:true}).click();
 await page.frameLocator('iframe').getByRole('button',{name:'Enter the world',exact:true}).click();
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 await page.waitForTimeout(12000);
 for(let i=0;i<2;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(800);}
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
}finally{await browser.close();}
