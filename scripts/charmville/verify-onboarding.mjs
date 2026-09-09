import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2]||'.charmville-onboarding-check';await mkdir(out,{recursive:true});
const browser=await chromium.launch();try{
const page=await browser.newPage({viewport:{width:1440,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://localhost:3017/charmville/start');await page.getByRole('heading',{name:'A little land. Your own story.'}).waitFor();await page.screenshot({path:out+'/welcome.png',fullPage:true});
const response=await page.request.post('http://localhost:3017/api/charmville/local-playtest',{headers:{Origin:'http://localhost:3017'}});assert.equal(response.status(),200);const session=await response.json();
await page.addInitScript(({wallet,token})=>{localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},session);
await page.reload();await page.getByRole('heading',{name:'Welcome home, @'+session.handle}).waitFor({timeout:45000});await page.waitForTimeout(1500);await page.screenshot({path:out+'/account.png',fullPage:true});
await page.getByRole('button',{name:'Claim your lot',exact:true}).click();await page.getByRole('button',{name:'Gather',exact:true}).waitFor();await page.getByRole('button',{name:'Gather',exact:true}).click();await page.getByRole('dialog',{name:'Satchel',exact:true}).waitFor({timeout:30000});await page.screenshot({path:out+'/first-harvest.png',fullPage:true});await page.reload();await page.getByRole('heading',{name:'Welcome home, @'+session.handle}).waitFor({timeout:45000});await page.getByRole('button',{name:'Choose plot 1',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Claim your lot',exact:true}).count(),0);console.log('Saved garden restored after claim and harvest');await writeFile(out+'/verification.json',JSON.stringify({errors,accountRestored:true,claimed:true,harvested:true,restoredAfterReload:true},null,2));assert.deepEqual(errors,[]);
}finally{await browser.close()}



