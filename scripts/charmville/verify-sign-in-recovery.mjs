import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch(),base='http://localhost:3017';
try{
 const page=await browser.newPage();const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(response.status(),200);const user=await response.json();
 // Use the real wallet bridge. Do not suppress wallet state or response events.
 await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);},user);
 let outage=true,delay=false,switchWallet=false;
 await page.route('**/api/auth/session?*',async route=>{
  if(outage){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary test outage'})});return;}
  if(delay){await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:'old-status-query',result:{state:{address:null,chainId:null,status:'disconnected',isConnected:false}}}})));await page.waitForTimeout(150);}
  if(switchWallet){switchWallet=false;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:{address:'0x'+'b'.repeat(40),chainId:null,status:'connected',isConnected:true}})));}
  await route.continue();
 });
 await page.goto(base+'/charmville/world?panel=garden');
 await page.getByText('Could not check your saved sign-in. Please try again.',{exact:true}).waitFor();
 assert(await page.evaluate(wallet=>!!localStorage.getItem('plankspace-session:'+wallet),user.wallet),'503 must retain the saved session');
 outage=false;delay=true;
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).click();
 await page.getByRole('tab',{name:'Garden',exact:true}).waitFor({timeout:30000});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:'late-status-query',result:{state:{address:null,chainId:null,status:'disconnected',isConnected:false}}}})));
 await page.waitForTimeout(300);assert(await page.getByRole('tab',{name:'Garden',exact:true}).isVisible(),'late snapshot must not disconnect account');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:{address:null,chainId:null,status:'disconnected',isConnected:false}})));
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).waitFor();
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).click();await page.getByRole('tab',{name:'Garden',exact:true}).waitFor();
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('plank:wallet-state',{detail:{address:null,chainId:null,status:'disconnected',isConnected:false}})));
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).waitFor();switchWallet=true;
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).click();
 await page.getByText('Wallet connection changed. Please finish connecting or try again.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Connect and sign in',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Garden',exact:true}).count(),0,'wallet switch must invalidate old identity');
 delay=false;await page.unrouteAll({behavior:'wait'});
 await page.screenshot({path:'work/sign-in-recovery.png'});
 console.log('Real bridge: temporary outage retains session, retry signs in, stale response cannot disconnect, live disconnect clears identity, retry restores.');
}finally{await browser.close();}
