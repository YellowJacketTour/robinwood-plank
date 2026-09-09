import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const browser=await chromium.launch();const base='http://localhost:3017';
try {
 const seed=await browser.newPage();
 async function fixture(){const r=await seed.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);const user=await r.json();const c=await seed.request.post(`${base}/api/charmville/${user.handle}`,{headers:{Origin:base,authorization:`Bearer ${user.token}`},data:{action:'claim',requestId:randomUUID()}});assert.equal(c.status(),200);return user;}
 const seller=await fixture(),buyer=await fixture();
 const harvest=await seed.request.post(`${base}/api/charmville/${seller.handle}`,{headers:{Origin:base,authorization:`Bearer ${seller.token}`},data:{action:'resolve',plotIndex:0,revision:'0',requestId:randomUUID()}});assert.equal(harvest.status(),200);
 async function pageFor(user){const context=await browser.newContext();await context.addInitScript(({wallet,token})=>{for(const type of ['plank:wallet-state','plank:wallet-response'])window.addEventListener(type,e=>{const state=type==='plank:wallet-state'?e.detail:e.detail?.result?.state;if(state&&state.address!==wallet)e.stopImmediatePropagation();},true);localStorage.setItem('plankspace-last-verified-wallet',wallet);localStorage.setItem('plankspace-session:'+wallet,token);window.addEventListener('plank:wallet-request',e=>{if(e.detail.method==='getState')window.dispatchEvent(new CustomEvent('plank:wallet-response',{detail:{requestId:e.detail.requestId,result:{state:{address:wallet,status:'connected',isConnected:true,chainId:null}}}}));});},user);const page=await context.newPage();await page.goto(base+'/charmville/world');await page.getByRole('region',{name:'Grained Exchange'}).waitFor({timeout:60000});return page;}
 const a=await pageFor(seller),b=await pageFor(buyer);const market=a.getByRole('region',{name:'Grained Exchange'});
 await market.getByLabel('Quantity',{exact:true}).fill('2');await market.getByRole('button',{name:'Review offer',exact:true}).click();
 assert.match(await market.getByRole('region',{name:'Review exchange action'}).innerText(),/Reserve 2 stalk/);
 let lost=false;await a.route('**/api/charmville/exchange',async route=>{if(route.request().method()==='POST'&&!lost){lost=true;await route.fetch();await route.abort();}else await route.continue();});
 await market.getByRole('button',{name:'Confirm exchange action'}).click();await market.getByText('The result is uncertain.',{exact:false}).waitFor();assert.equal(await market.getByRole('button',{name:'Back',exact:true}).isDisabled(),true);
 await market.getByRole('button',{name:'Confirm exchange action'}).click();await market.getByText('Your sell offer',{exact:true}).waitFor();assert.equal(await market.getByText('Your sell offer',{exact:true}).count(),1);
 const other=b.getByRole('region',{name:'Grained Exchange'});await other.getByRole('button',{name:'Refresh offers'}).click();
 const offer=other.getByRole('listitem').filter({hasText:`@${seller.handle}’s sell offer`});await offer.getByRole('button',{name:'Review purchase'}).click();
 assert.match(await other.getByRole('region',{name:'Review exchange action'}).innerText(),/Pay 1 Grain and receive 1 stalk/);
 await other.getByRole('button',{name:'Confirm exchange action'}).click();await other.getByText('Exchange action saved. Your inventory has been updated.').waitFor();
 await market.getByRole('button',{name:'Refresh offers'}).click();await market.getByText('1 stalk · 1 Grain each',{exact:true}).waitFor();await market.getByRole('button',{name:'Cancel offer'}).click();await market.getByRole('button',{name:'Confirm exchange action'}).click();await market.getByText('Your sell offer',{exact:true}).waitFor({state:'detached'});
 const balance=await b.request.get(`${base}/api/charmville/${buyer.handle}`,{headers:{authorization:`Bearer ${buyer.token}`}});const state=await balance.json();assert.equal(state.inventory.grain,'1');assert.equal(state.inventory.faces.find(x=>x.face==='stalk').qty,'1');
 await b.screenshot({path:'work/exchange-panel.png',fullPage:true});console.log('Two-player reviewed offer, partial fill, cancellation and real balances verified.');
}finally{await browser.close();}
