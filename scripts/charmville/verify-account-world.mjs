import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://localhost:3017',out=process.argv[2]||'work/account-world';
await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')console.log('Browser:',message.text());});
 page.on('requestfailed',request=>console.log('Request:',request.url().split('?')[0],request.failure()?.errorText));
 async function fixture(){const r=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);return r.json();}
 const owner=await fixture(),friend=await fixture();
 const headers={Origin:base,Authorization:`Bearer ${owner.token}`};
 assert.equal((await page.request.post(`${base}/api/charmville/${owner.handle}`,{headers,data:{action:'claim',requestId:randomUUID()}})).status(),200);
 assert.equal((await page.request.post(`${base}/api/charmville/${owner.handle}/access`,{headers,data:{visitor:friend.handle,rights:['visit'],containers:[],expiresAt:new Date(Date.now()+3600000).toISOString(),revision:'0',revoke:false}})).status(),200);
 const second=await browser.newPage();
 async function authenticate(target,fixture){
  await target.addInitScript(({wallet,token})=>{
   for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state&&state.address!==wallet)e.stopImmediatePropagation();},true);
   localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);
   window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});
  },fixture);
  await target.goto(base+'/charmville/world');await target.getByRole('tab',{name:'Friends',exact:true}).click();await target.getByRole('heading',{name:'@'+fixture.handle,exact:true}).waitFor({timeout:60000});
 }
 await authenticate(page,owner);await authenticate(second,friend);
 await page.getByRole('button',{name:'Go home',exact:true}).click();
 await page.getByText(`At @${owner.handle}’s home`,{exact:true}).waitFor();
 await second.getByLabel('Visit a friend').fill(owner.handle);await second.getByRole('button',{name:'Visit home',exact:true}).click();
 await second.getByText(`At @${owner.handle}’s home`,{exact:true}).waitFor();
 await page.getByRole('button',{name:'Refresh account'}).click();
 await page.getByRole('region',{name:'Players here'}).getByText('@'+friend.handle,{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Satchel',exact:true}).click();await page.getByRole('region',{name:'Saved inventory'}).getByText('Gameplay supplies',{exact:true}).waitFor();
 assert.equal((await page.request.post(`${base}/api/charmville/${owner.handle}/access`,{headers,data:{visitor:friend.handle,revision:'1',revoke:true}})).status(),200);
 await second.getByRole('button',{name:'Refresh account'}).click();
 await second.getByText('Choose where to join',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Play',exact:true}).click();await page.locator('iframe').waitFor({state:'attached'});
 await page.screenshot({path:out+'/before-camera.png',fullPage:true});
 const iframe=page.frameLocator('iframe');
 await iframe.getByRole('button',{name:'Enter the world',exact:true}).click({timeout:60000});
 await page.waitForTimeout(12000);
 const native=page.frames().find(frame=>frame.url().startsWith('http://localhost:3021/play/'));
 assert(native,'Native frame loaded');
 assert.equal(await native.evaluate(()=>crossOriginIsolated),true);
 assert.equal(await native.evaluate(()=>document.querySelector('canvas')?.width>0),true);
 assert(!native.url().includes(owner.token));
 await page.screenshot({path:out+'/account-world.png',fullPage:true});
 await page.getByRole('button',{name:'Toggle fullscreen'}).click();
 await page.waitForFunction(()=>Boolean(document.fullscreenElement));
 await page.getByRole('button',{name:'Toggle fullscreen'}).click();
 await page.waitForFunction(()=>!document.fullscreenElement);
 for(const [width,height] of [[600,900],[390,844]]){
  await page.setViewportSize({width,height});
  for(const name of ['Inventory','Companions','Exchange','Friends']){
   await page.getByRole('tab',{name,exact:true}).click();
   const selected=page.getByRole('tabpanel',{name,exact:true});
   await selected.waitFor({state:'visible'});
   assert((await selected.boundingBox()).y<450,`${name} immediately accessible at ${width}px`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.getByRole('tab',{name:'Exchange',exact:true}).click();
  await page.getByLabel('Quantity',{exact:true}).fill('2');
  await page.getByRole('tab',{name:'Satchel',exact:true}).click();
  await page.getByRole('tab',{name:'Exchange',exact:true}).click();
  assert.equal(await page.getByLabel('Quantity',{exact:true}).inputValue(),'2');
  await page.screenshot({path:out+`/account-world-${width}.png`,fullPage:true});
 }
 await page.getByRole('tab',{name:'Satchel',exact:true}).focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.getByRole('tab',{name:'Party',exact:true}).getAttribute('aria-selected'),'true');
 await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'Friends',exact:true}).getAttribute('aria-selected'),'true');
 await page.keyboard.press('Home');assert.equal(await page.getByRole('tab',{name:'Play',exact:true}).getAttribute('aria-selected'),'true');
 await page.screenshot({path:out+'/account-world-mobile.png',fullPage:true});
 await writeFile(out+'/verification.json',JSON.stringify({accountHome:true,friendVisit:true,revokedVisitCleared:true,sharedPresence:true,canonicalInventory:true,nativeFrameIsolated:true,fullscreen:true,mobileNoOverflow:true,errors},null,2));
 assert.deepEqual(errors,[]);console.log('Account home, authorized friend visit, shared presence, inventory and isolated native camera verified');
}finally{await browser.close();}
