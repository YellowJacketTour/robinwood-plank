import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const name=process.argv[2]||'TREECKO',speciesId={TREECKO:277,TORCHIC:280,MUDKIP:283}[name];assert(speciesId);
const base='http://localhost:3017',out='work/account-follower-'+name.toLowerCase();
await mkdir(out,{recursive:true});const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1100,height:950}}),events=[],errors=[];
 page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 const r=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);const user=await r.json();
 assert.equal((await page.request.post(`${base}/api/charmville/${user.handle}`,{headers:{Origin:base,authorization:`Bearer ${user.token}`},data:{action:'claim',requestId:randomUUID()}})).status(),200);
 await page.addInitScript(({wallet,token})=>{for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state&&state.address!==wallet)e.stopImmediatePropagation();},true);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);
 await page.goto(base+'/charmville/world?panel=companions');const party=page.getByRole('region',{name:'Your companion'});
 await party.getByRole('button',{name}).click();await party.getByRole('button',{name:'Confirm companion'}).click();await party.getByRole('button',{name:'Walk with me',exact:true}).click();await party.getByRole('button',{name:'Return to party',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Play',exact:true}).click();await page.locator('iframe').waitFor({state:'attached'});
 const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'Enter the world',exact:true}).click();
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 await runtime.waitForFunction((expected)=>typeof FS!=='undefined'&&FS.analyzePath(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt').exists&&FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt',{encoding:'utf8'})===String(expected),speciesId,{timeout:60000});
 await page.waitForTimeout(11000);
 for(let i=0;i<2;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(800);}
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(900);await page.keyboard.up('ArrowRight');await page.waitForTimeout(600);
 await writeFile(out+'/debug.json',JSON.stringify({events,errors},null,2));await page.screenshot({path:out+'/debug.png'});
 assert(events.some(e=>e==='CHARMVILLE_FOLLOWER '+speciesId),'Account selection must reach the native script');
 assert(events.some(e=>e.includes('CHARMVILLE_FOLLOWER_DRAW '+speciesId)),'The selected follower must render along actual movement');
 await page.screenshot({path:out+'/following.png'});
 await page.getByRole('tab',{name:'Companions',exact:true}).click();await party.getByRole('button',{name:'Return to party',exact:true}).click();await party.getByRole('button',{name:'Walk with me',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Play',exact:true}).click();await runtime.waitForFunction(()=>FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt',{encoding:'utf8'})==='0');await page.waitForTimeout(1200);
 assert(events.some(e=>e==='CHARMVILLE_FOLLOWER 0'),'Returning the companion must hide its native projection');
 assert.deepEqual(errors,[]);await writeFile(out+'/verification.json',JSON.stringify({events,errors},null,2));
 console.log('Account party selection, persisted follow preference, native follower trail and return verified.');
}finally{await browser.close();}
