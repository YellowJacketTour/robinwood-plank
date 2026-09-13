import {measureFrameTiming} from './measure-frame-timing.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createHash, randomBytes } from 'node:crypto';
await mkdir('.dream-loop',{recursive:true});
const db=new URL(process.env.CHARMVILLE_TEST_DATABASE_URL);
const base=new URL(process.env.CHARMVILLE_TEST_BASE_URL||'http://localhost:3017');
if(!['localhost','127.0.0.1'].includes(db.hostname)||!['localhost','127.0.0.1'].includes(base.hostname))throw Error('Local isolated verification only');
const pool=new Pool({connectionString:db.href});
const wallet='0x'+randomBytes(20).toString('hex'),token=randomBytes(32).toString('hex');
const handle='art_'+randomBytes(5).toString('hex');
const browser=await chromium.launch({headless:true});
let page;
try{
 await pool.query("INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status,layout_json) VALUES($1,$2,'Charmville art check','approved','[\"feed\",\"friends\"]')",[wallet,handle]);
 await pool.query('INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),wallet,new Date(Date.now()+3600000).toISOString()]);
 const post=await pool.query("INSERT INTO plankspace_posts(author_wallet,body) VALUES($1,'A little Stalk from my corner of the Lumberyard.') RETURNING id::text",[wallet]);
 page=await browser.newPage({viewport:{width:1280,height:1400}});
 const timings=[];
 const foreign=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/x/'))foreign.push(r.url())});
 await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-terms-2026-08-22-v1','accepted');localStorage.setItem('plankspace-session:'+wallet,token);localStorage.setItem('plankspace-last-verified-wallet',wallet);window.ethereum={isMetaMask:true,request:async({method})=>{if(method==='eth_accounts'||method==='eth_requestAccounts')return[wallet];if(method==='eth_chainId')return'0x1237';if(method==='personal_sign')throw Error('Unexpected fresh signature');return null;},on(){},removeListener(){}};},{wallet,token});
 await page.goto(new URL('/u/'+handle,base).href);
 const porch=page.getByRole('region',{name:'Charmville porch'});
 await porch.getByRole('button',{name:'Claim your lot',exact:true}).click();
 await page.locator('[data-plot="0"][data-stage="ripe"]').waitFor();
 await porch.locator('summary').filter({hasText:'Field guide'}).click();
 await porch.getByText('2 ripe beds are waiting. Use Find ripe plot, then Gather.',{exact:true}).waitFor();
 await porch.locator('summary').filter({hasText:'Field guide'}).click();
 await porch.getByRole('button',{name:'Gather',exact:true}).click();
 const bag=page.getByRole('dialog',{name:'Satchel'});await bag.waitFor();
 await bag.getByRole('combobox').selectOption(post.rows[0].id);
 const recoveryUrl=new URL('/api/charmville/'+handle,base).href;
 let interrupted=false;
 await page.route(recoveryUrl,async route=>{
   const request=route.request();
   if(!interrupted&&request.method()==='POST'&&request.postDataJSON()?.action==='stamp'){
     interrupted=true;const accepted=await route.fetch();
     if(!accepted.ok())throw Error('Fixture stamp was not accepted before response interruption');
     await route.abort('failed');return;
   }
   await route.continue();
 });
 await bag.getByRole('button',{name:/^SEND/}).click();
 await porch.getByRole('button',{name:'Check / retry pending action',exact:true}).waitFor();
 await page.unroute(recoveryUrl);
 await page.reload();
 await page.route(recoveryUrl,async route=>{
   if(route.request().method()==='POST')return route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Please retry shortly.'})});
   await route.continue();
 });
 await porch.getByRole('button',{name:'Check / retry pending action',exact:true}).click();
 await porch.getByText('Please retry shortly.',{exact:true}).waitFor();
 await page.unroute(recoveryUrl);
 await page.reload();
 await porch.getByRole('button',{name:'Check / retry pending action',exact:true}).click();
 await page.getByText('Stalk stamped onto your Grain. Your seed stays home.',{exact:true}).waitFor();
 await porch.getByRole('button',{name:'Satchel',exact:true}).click();
 await bag.waitFor();
 await page.screenshot({path:'.charmville-desk-satchel.png'});
 await bag.getByRole('button',{name:'Back to garden · plant stalk',exact:true}).click();
 if(!await porch.getByRole('radio',{name:/Stalk/}).isChecked())throw Error('Satchel return did not select Stalk for planting');
 await porch.getByRole('button',{name:'Plant here',exact:true}).click();
 await page.locator('[data-plot="0"][data-stage="seedling"]').waitFor();
 // A portaled satchel must take/restore focus without moving the board beneath it.
 for(const viewport of [{width:1280,height:844},{width:390,height:844}]) {
  await page.setViewportSize(viewport);
  await porch.evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+window.scrollY+250));
  await page.waitForTimeout(100);
  const before=await page.evaluate(()=>window.scrollY);
  await porch.getByRole('button',{name:'Satchel',exact:true}).evaluate(el=>el.click());
  await bag.waitFor();
  if(!await bag.evaluate(el=>document.activeElement===el))throw Error('Satchel did not receive keyboard focus');
  if(Math.abs(await page.evaluate(()=>window.scrollY)-before)>2)throw Error('Opening satchel moved the board');
  if(viewport.width>600){
   const mover=bag.getByLabel('Move satchel: use arrow keys, or Home to reset');
   await mover.evaluate(el=>el.focus({preventScroll:true}));
   const initial=await bag.boundingBox();await page.keyboard.press('ArrowRight');
   const moved=await bag.boundingBox();if(!initial||!moved||Math.abs(moved.x-initial.x-10)>1)throw Error('Keyboard satchel movement failed');
  }
  await bag.getByRole('button',{name:'Close satchel'}).evaluate(el=>el.click());
  await bag.waitFor({state:'hidden'});
  if(Math.abs(await page.evaluate(()=>window.scrollY)-before)>2)throw Error('Closing satchel moved the board');
 }
 await porch.getByRole('button',{name:'Open the lot',exact:true}).evaluate(el=>el.click());
 const expandedBounds=await porch.boundingBox();
 if(!expandedBounds||Math.abs(expandedBounds.y)>1||Math.abs(expandedBounds.width-390)>1||Math.abs(expandedBounds.height-844)>1)throw Error('Expanded mobile lot does not fill viewport');
 await page.keyboard.press('Escape');
 if(!await porch.getByRole('button',{name:'Open the lot',exact:true}).evaluate(el=>document.activeElement===el))throw Error('Closing lot did not restore focus');
 await page.setViewportSize({width:1280,height:1400});
 // Wallet reattachment must clear private state without collapsing the public garden.
 const yardUrl=new URL('/api/charmville/'+handle,base).href;
 await porch.getByRole('button',{name:'Arrange scenery',exact:true}).click();
 await page.getByRole('button',{name:'Place tree at 1, 2',exact:true}).click();
 await page.route(yardUrl,async route=>{await new Promise(resolve=>setTimeout(resolve,300));await route.continue();});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:{address:null,chainId:null,status:'disconnected',isConnected:false}})));
 await page.waitForTimeout(80);
 if(await page.locator('[data-plot]').count()!==6)throw Error('Wallet reattachment collapsed the garden');
 if(await page.getByRole('button',{name:'Place tree at 1, 2',exact:true}).count())throw Error('Scenery editing remained available during identity transition');
 await porch.getByText(`Your garden · @${handle}`,{exact:true}).waitFor();
 await page.unroute(yardUrl);
 await porch.getByRole('button',{name:'Save scenery',exact:true}).waitFor();
 await porch.getByText('Draft moved. Save scenery to keep it.',{exact:true}).waitFor();
 await porch.getByRole('button',{name:'Cancel changes',exact:true}).click();
 await porch.scrollIntoViewIfNeeded();
 const frame=page.locator('[data-plot="1"] image').nth(1);
 await page.waitForFunction(()=>{const sprite=document.querySelector('[data-plot="1"] svg image');return sprite&&getComputedStyle(sprite).animationPlayState==='running';});
 const state=await frame.evaluate(e=>getComputedStyle(e).animationPlayState);if(state!=='running')throw Error('Visible animation not running');
 await page.emulateMedia({reducedMotion:'reduce'});if(await frame.evaluate(e=>getComputedStyle(e).animationName)!=='none')throw Error('Reduced motion ignored');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await porch.getByRole('button',{name:'Arrange scenery',exact:true}).click();
 await page.getByRole('button',{name:'Place tree at 1, 2',exact:true}).click();
 await porch.getByRole('button',{name:'Save scenery',exact:true}).click();
 await porch.getByRole('button',{name:'Arrange scenery',exact:true}).waitFor();
 await page.reload();await porch.getByRole('button',{name:'Arrange scenery',exact:true}).waitFor();
 await porch.scrollIntoViewIfNeeded();
 await porch.screenshot({path:'.charmville-isometric-desktop.png'});
 if(process.env.CHARMVILLE_MEASURE)timings.push(await measureFrameTiming(page,'desktop'));

 await page.setViewportSize({width:390,height:844});
 await porch.getByRole('button',{name:'Choose plot 2',exact:true}).click();
 if(process.env.CHARMVILLE_MEASURE)timings.push(await measureFrameTiming(page,'mobile viewport / 4x CPU',4));
 const box=await porch.boundingBox();
 if(!box||box.width>392)throw Error('Porch overflows mobile viewport');
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'.charmville-board-mobile.png',fullPage:true});
 await page.setViewportSize({width:390,height:1300});
 await porch.scrollIntoViewIfNeeded();
 await porch.screenshot({path:'.charmville-isometric-mobile.png'});
 await page.setViewportSize({width:390,height:844});
 await porch.getByRole('button',{name:'Satchel',exact:true}).click();
 await bag.waitFor();if(await page.getByRole('dialog',{name:'Satchel'}).count()!==1)throw Error('Multiple satchel sheets');
 await bag.screenshot({path:'.charmville-isometric-satchel.png'});
 await page.setViewportSize({width:1280,height:1400});await page.reload();
 await porch.getByText(`Your garden · @${handle}`,{exact:true}).waitFor();
 await page.locator('[data-plot="0"][data-stage="seedling"]').waitFor();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'.charmville-board-desktop.png',fullPage:true});
 if(process.env.CHARMVILLE_MEASURE){await writeFile('.dream-loop/frame-timing.json',JSON.stringify(timings,null,2));console.log(JSON.stringify(timings));}
 if(foreign.length)throw Error('Unexpected foreign API calls');
 const result=await page.request.get(new URL('/api/charmville/'+handle,base).href,{headers:{authorization:'Bearer '+token}});const yard=await result.json();
 if(yard.decorations.find(item=>item.id===0)?.y!==1)throw Error('Scenery did not persist after reload');
 if(yard.inventory.faces.find(s=>s.face==='stalk')?.qty!=='2')throw Error('Harvest/stamp balance incorrect');
 if(yard.inventory.seeds.find(s=>s.face==='stalk')?.qty!=='2')throw Error('Seed return/replant incorrect');
 console.log('PASS: claim, harvest without signature, seed return, replant, animation, reduced motion, 390px sheet, no X API.');
}catch(error){if(page){console.error((await page.locator("body").innerText()).slice(-2500));await page.screenshot({path:".charmville-browser-error.png"});}throw error;}finally{await browser.close();await pool.query('DELETE FROM plankspace_wallet_sessions WHERE wallet=$1',[wallet]);for(const table of ['charmville_stamps','charmville_receipts','charmville_plots','charmville_seeds','charmville_stacks','charmville_yards'])await pool.query(`DELETE FROM ${table} WHERE profile_id=(SELECT id FROM plankspace_profiles WHERE wallet=$1)`,[wallet]);await pool.query('DELETE FROM plankspace_posts WHERE author_wallet=$1',[wallet]);await pool.query('DELETE FROM plankspace_profiles WHERE wallet=$1',[wallet]);await pool.end();}
