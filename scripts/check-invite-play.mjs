import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.PLANK_INVITE_URL||'http://127.0.0.1:8766';
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const out=resolve(process.env.PLANK_INVITE_OUTPUT||'work/invite-proof');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const errors=[],failed=[];
try{
  const pages=[];
  for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
    const context=await browser.newContext({viewport,permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();pages.push(page);
    page.on('pageerror',e=>errors.push(e.message));
    const rpcErrors=new Set();
    page.on('response',async r=>{if(r.url().endsWith('/api/invite/rpc'))try{const data=await r.json();for(const reply of Array.isArray(data)?data:[data])if(reply.error&&!rpcErrors.has(reply.error.message)){rpcErrors.add(reply.error.message);console.log('RPC:',reply.error.message);}}catch{}});
    page.on('console',m=>{if(m.type()==='error')failed.push(m.text().slice(0,200));});
    await page.addInitScript(()=>{window.inviteProof={draws:[],presented:[],phases:[]};document.addEventListener('plank:lottery-result',e=>window.inviteProof.draws.push(e.detail));document.addEventListener('plank:lottery-presented',e=>window.inviteProof.presented.push(e.detail));setInterval(()=>{const p=document.querySelector('.stage')?.dataset.presentation;if(p&&!window.inviteProof.phases.includes(p))window.inviteProof.phases.push(p);},50);});
    await page.goto(`${base}/#invite=${token}`);
    await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000}).catch(async error=>{await page.screenshot({path:resolve(out,'failed.png')});console.log({errors,failed,text:await page.locator('body').innerText()});throw error;});
    assert.match(await page.locator('#stakeValueQuote').textContent(),/no cash value/);
    assert.equal(await page.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
    await page.locator('.invite-repeat').click();
    assert.equal(await page.locator('.invite-repeat').getAttribute('aria-pressed'),'true');
    await page.screenshot({path:resolve(out,`ready-${viewport.width}.png`)});
    console.log('Guest connected:',viewport.width);
  }
  const identities=await Promise.all(pages.map(p=>p.locator('.invite-player output').getAttribute('data-address')));assert.notEqual(...identities);
  const attacker=pages[0];
  await attacker.bringToFront();
  const denied=await attacker.evaluate(async()=>{
    const methods=['hardhat_reset','eth_accounts','eth_sendTransaction','evm_mine'];const results=[];
    for(const method of methods){const r=await fetch('/api/invite/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});results.push({method,error:(await r.json()).error?.message});}
    for(const path of ['/arcade/safety.html','/arcade/dev-panel.html','/../.env','/arcade/deploy-addresses.testnet.json'])results.push({path,status:(await fetch(path)).status});return results;
  });
  assert.ok(denied.every(r=>r.error||r.status>=400));
  console.log('Gateway denials passed');
  await attacker.locator('.invite-copy').click();await attacker.bringToFront();
  const copied=await attacker.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Clipboard read timed out')),8000))]));assert.equal(copied,`${base}/#invite=${token}`);
  console.log('Invite copy verified');
  const deadline=Date.now()+Number(process.env.PLANK_INVITE_TEST_MS||150000);let gumball=false;
  while(Date.now()<deadline){
    for(const p of pages){
      if(await p.locator('.lottery-theatre[open][data-reveal="presented"]').count()){
        await p.evaluate(()=>document.querySelector('.lottery-theatre[open]')?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})));
        if(!gumball){await p.screenshot({path:resolve(out,'gumball.png')});gumball=true;}
        if(await p.locator('.lottery-collect:not([hidden])').count())await p.locator('.lottery-collect').click();
        await p.evaluate(()=>document.querySelector('.lottery-theatre[open] .lottery-next')?.click());
      }
    }
    if((await pages[0].evaluate(()=>window.inviteProof.draws.filter(d=>d.participated&&d.verified).length))>=2&&(await pages[1].evaluate(()=>window.inviteProof.draws.filter(d=>d.participated&&d.verified).length))>=2)break;
    await pages[0].waitForTimeout(300);
  }
  const proofs=await Promise.all(pages.map(p=>p.evaluate(()=>window.inviteProof)));
  await writeFile(resolve(out,'raw-proof.json'),JSON.stringify(proofs,null,2));
  for(const p of proofs){assert.ok(p.draws.filter(d=>d.participated&&d.verified).length>=2,'Two verified, automatically played rounds');assert.ok(p.phases.includes('flight'));assert.ok(p.phases.includes('crash'));}
  const common=proofs[0].draws.filter(d=>proofs[1].draws.some(e=>e.roundId===d.roundId));assert.ok(common.length);
  for(const d of common){const e=proofs[1].draws.find(e=>e.roundId===d.roundId);for(const key of ['sample','ballCount','drawnBall','winner','paid','threshold'])assert.equal(d[key],e[key],`shared ${key}`);}
  await pages[0].locator('.invite-repeat').click();assert.equal(await pages[0].locator('.invite-repeat').getAttribute('aria-pressed'),'false');
  await pages[0].reload();
  await pages[0].waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
  assert.equal(await pages[0].locator('.invite-player output').getAttribute('data-address'),identities[0]);
  assert.equal(await pages[0].locator('.invite-repeat').getAttribute('aria-pressed'),'false','Pause survives reconnect');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(out,'proof.json'),JSON.stringify({passed:true,base,identities,denied,gumball,proofs,errors,consoleErrors:failed},null,2));
  console.log(JSON.stringify({passed:true,identities,rounds:proofs.map(p=>p.draws.map(d=>d.roundId)),gumball,errors,consoleErrors:failed}));
}finally{await browser.close();}
