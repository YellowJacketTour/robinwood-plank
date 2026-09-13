import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';

import {mkdir,writeFile} from 'node:fs/promises';
const name=process.argv[2]||'TREECKO',speciesId={TREECKO:277,TORCHIC:280,MUDKIP:283}[name];assert(speciesId);
const base='http://localhost:3017',out='work/account-six-party-'+name.toLowerCase();
await mkdir(out,{recursive:true});const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1100,height:950}}),events=[],errors=[];
 page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
 const r=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);const user=await r.json();
 await page.addInitScript(({wallet,token})=>{for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state&&state.address!==wallet)e.stopImmediatePropagation();},true);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);
 await page.goto(base+'/charmville/world?panel=companions');const party=page.getByRole('region',{name:'Your companion'});
 await party.getByRole('button',{name:'Set up home',exact:true}).click(); await party.getByRole('button',{name}).click();await party.getByRole('button',{name:'Confirm companion'}).click();await party.getByRole('button',{name:'Walk with me',exact:true}).waitFor();
 // Deliberate local test fixtures only: no gameplay acquisition is claimed.
 const url=process.env.CHARMVILLE_TEST_DATABASE_URL;assert(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
 const db=new Pool({connectionString:url});const ids=[];
 try{const owner=await db.query('SELECT id FROM plankspace_profiles WHERE wallet=$1 AND handle=$2',[user.wallet,user.handle]);assert.equal(owner.rowCount,1);assert(user.handle.startsWith('local_demo_'));
 for(const [index,id] of [280,283,277,280,283].entries()){const uuid=randomUUID();await db.query("INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind) VALUES($1,$2,$3,$4,'capture')",[uuid,owner.rows[0].id,id,'Test creature '+(index+2)]);ids.push(uuid);}
 }finally{await db.end();}
 const headers={Origin:base,authorization:'Bearer '+user.token};
 const roster=await(await page.request.get(base+'/api/charmville/creature-roster',{headers})).json();
 const assigned=await page.request.post(base+'/api/charmville/creature-roster',{headers,data:{revision:roster.revision,slots:[roster.slots[0].id,...ids]}});assert.equal(assigned.status(),200);
 await party.getByRole('button',{name:'Refresh companion',exact:true}).click();await party.getByText('6 / 6',{exact:true}).waitFor();
 await party.getByRole('button',{name:'Walk with me',exact:true}).click();await party.getByRole('button',{name:'Return to party',exact:true}).waitFor();
 await party.getByRole('button',{name:'Return to play',exact:true}).click();
 const frame=page.frameLocator('iframe');await frame.getByRole('button',{name:'Enter the world',exact:true}).click();
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 await runtime.waitForFunction((expected)=>typeof FS!=='undefined'&&FS.analyzePath(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt').exists&&FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt',{encoding:'utf8'})===String(expected),speciesId,{timeout:60000});
 await page.waitForTimeout(11000);
 for(let i=0;i<2;i++){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(800);}
 for(const [key,ms] of [['ArrowDown',500],['ArrowRight',1500],['ArrowUp',450],['ArrowLeft',350]]){await page.keyboard.down(key);await page.waitForTimeout(ms);await page.keyboard.up(key);await page.waitForTimeout(200);}
 for(const [slot,id] of [277,280,283,277,280,283].entries())assert(events.includes('CHARMVILLE_PARTY_DRAW '+slot+' '+id),'Owned fixture slot must render '+slot);
 await writeFile(out+'/debug.json',JSON.stringify({events,errors},null,2));await page.screenshot({path:out+'/debug.png'});
 assert(events.some(e=>e==='CHARMVILLE_FOLLOWER '+speciesId),'Account selection must reach the native script');
 assert(events.some(e=>e.includes('CHARMVILLE_FOLLOWER_DRAW '+speciesId)),'The selected follower must render along actual movement');
 await page.screenshot({path:out+'/following.png'});
 await page.getByRole('tab',{name:'Party',exact:true}).click();await party.getByRole('button',{name:'Return to party',exact:true}).click();await party.getByRole('button',{name:'Walk with me',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Play',exact:true}).click();await runtime.waitForFunction(()=>FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/follower.txt',{encoding:'utf8'})==='0');await page.waitForTimeout(1200);
 assert(events.some(e=>e==='CHARMVILLE_FOLLOWER 0'),'Returning the companion must hide its native projection');
 assert.deepEqual(errors,[]);await writeFile(out+'/verification.json',JSON.stringify({events,errors},null,2));
 console.log('Six database fixture entities through roster API, UI, native drawing and recall verified; acquisition gameplay is not implemented.');
}finally{await browser.close();}
