import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1200,height:1000}});
 const base='http://localhost:3017';
 async function fixture(){const response=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(response.status(),200);return response.json();}
 const owner=await fixture(),friend=await fixture();
 const claim=await page.request.post(`${base}/api/charmville/${owner.handle}`,{headers:{Origin:base,Authorization:`Bearer ${owner.token}`},data:{action:'claim',requestId:randomUUID()}});assert.equal(claim.status(),200);
 await page.addInitScript(({wallet,token})=>{for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state && state.address!==wallet)e.stopImmediatePropagation();},true);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},owner);
 await page.goto(base+'/charmville/start');
 await page.getByRole('heading',{name:'Welcome home, @'+owner.handle}).waitFor({timeout:60000});
 const panel=page.getByRole('region',{name:'Garden visitors'});
 await panel.getByLabel('Player handle').fill(friend.handle);
 await panel.getByRole('button',{name:'Save invitation'}).click();
 await panel.getByText('Garden access saved for seven days.').waitFor();
 let response=await page.request.get(`${base}/api/charmville/${owner.handle}/access`,{headers:{Authorization:`Bearer ${friend.token}`}});
 let state=await response.json();assert.equal(state.grants[0].active,true);assert.deepEqual(state.grants[0].rights,['visit','help']);
 await panel.getByRole('button',{name:`Revoke access for ${friend.handle}`}).click();
 await panel.getByText('Access revoked.',{exact:true}).waitFor();
 response=await page.request.get(`${base}/api/charmville/${owner.handle}/access`,{headers:{Authorization:`Bearer ${friend.token}`}});state=await response.json();assert.equal(state.grants[0].active,false);
 await page.reload();await panel.getByText('Revoked',{exact:true}).waitFor({timeout:30000});
 await page.screenshot({path:'work/home-permissions.png',fullPage:true});
 console.log('Home invitation, visitor read, revocation and reload verified in browser.');
}finally{await browser.close();}
