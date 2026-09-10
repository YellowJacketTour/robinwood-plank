import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base='http://localhost:3017';
const browser=await chromium.launch();
try{
 const page=await browser.newPage();
 const account=async()=>{
  const r=await page.request.post(base+'/api/charmville/local-playtest',{headers:{Origin:base}});assert.equal(r.status(),200);const user=await r.json();
  const headers={Origin:base,authorization:`Bearer ${user.token}`};
  const p=await(await page.request.get(base+'/api/charmville/world/presence',{headers})).json();
  assert.equal((await page.request.post(base+'/api/charmville/world/presence',{headers,data:{destination:'public',revision:p.revision}})).status(),200);
  const actor=await(await page.request.get(base+'/api/charmville/world/actor',{headers})).json();return {...user,headers,actor};
 };
 const a=await account(),b=await account();
 await page.addInitScript(user=>{sessionStorage.setItem('charmville-local-test-wallet',user.wallet);localStorage.setItem('plankspace-session:'+user.wallet,user.token);},a);
 await page.goto(base+'/charmville/world?panel=play');
 await page.frameLocator('iframe').getByRole('button',{name:'Enter the world',exact:true}).click();
 const runtime=page.frames().find(f=>f.url().startsWith('http://localhost:3021/play/'));assert(runtime);
 await runtime.waitForFunction(()=>typeof FS!=='undefined'&&FS.analyzePath(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/account-peers.txt').exists,{},{timeout:60000});
 await page.waitForTimeout(14000);
 await runtime.locator('canvas').scrollIntoViewIfNeeded();await runtime.locator('canvas').click();
 for(let i=0;i<2;i++){await page.keyboard.press('d');await page.waitForTimeout(800);}
 const actor=await(await page.request.get(base+'/api/charmville/world/actor',{headers:a.headers})).json();
 const index=actor.peers.findIndex(p=>p.profileId===b.actor.profileId);assert(index>=0);
 await runtime.evaluate(index=>{
  window.peerSamples=[];
  window.peerSampleTimer=setInterval(()=>{try{const fields=FS.readFile(FS.cwd().replace(/\/$/,'')+'/Files/Homestead/charmville/account-peers.txt',{encoding:'utf8'}).replace(/\0/g,'').split('|').map(Number);window.peerSamples.push(fields[2+index*2]);}catch{}},10);
 },index);
 await page.waitForTimeout(200);
 const moved=await page.request.post(base+'/api/charmville/world/actor',{headers:b.headers,data:{x:b.actor.cell.x+1,y:b.actor.cell.y,sequence:b.actor.sequence+1,regionEpoch:b.actor.regionEpoch,presenceRevision:b.actor.presenceRevision,geometryId:b.actor.geometryId}});assert.equal(moved.status(),200);
 const from=b.actor.cell.x*8,to=from+8;
 await runtime.waitForFunction(to=>window.peerSamples.includes(to),to,{timeout:8000});
 const samples=await runtime.evaluate(()=>{clearInterval(window.peerSampleTimer);return window.peerSamples;});
 assert(samples.some(x=>x>from&&x<to),'A real remote step must produce intermediate rendered positions');
 await runtime.locator('canvas').screenshot({path:'work/peer-smoothing.png'});
 console.log('Authenticated remote step produced intermediate presentation pixels and reached the committed target.');
}finally{await browser.close();}
