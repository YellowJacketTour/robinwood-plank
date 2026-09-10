import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const out=process.env.PLANK_INVITE_OUTPUT;await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});const errors=[];
try{
 const pages=[];
 for(const width of [390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:844}});const p=await ctx.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{window.clockProof={draws:[],intervals:[]};let lastResult=null,flying=false;
   document.addEventListener('plank:lottery-result',e=>window.clockProof.draws.push(e.detail));
   document.addEventListener('plank:lottery-presented',e=>{lastResult={round:e.detail.roundId,t:performance.now()};});
   document.addEventListener('plank:liftoff',e=>{if(lastResult){window.clockProof.intervals.push({afterRound:lastResult.round,ms:performance.now()-lastResult.t,lateMs:e.detail.presentedAt-e.detail.scheduledAt});lastResult=null;}});
  });
  await p.goto(`${process.env.PLANK_INVITE_URL}/#invite=${token}`);await p.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
  assert.equal(await p.locator('.invite-repeat').getAttribute('aria-pressed'),'false');await p.locator('.invite-repeat').click();
  await p.screenshot({path:`${out}/command-${width}.png`});
 }
 const deadline=Date.now()+240000;
 while(Date.now()<deadline){
  for(const p of pages){if(await p.locator('.lottery-theatre[open][data-reveal="presented"] .lottery-collect:not([hidden]):not(:disabled)').count()){
   await p.locator('.lottery-collect').click();
   await p.waitForFunction(()=>document.querySelector('.lottery-collect')?.hidden,null,{timeout:15000});
   await p.evaluate(()=>document.querySelector('.lottery-theatre[open] .lottery-next')?.click());
  }}
  if((await Promise.all(pages.map(p=>p.evaluate(()=>window.clockProof.intervals.length)))).every(n=>n>=2))break;await pages[0].waitForTimeout(500);}
 const proofs=await Promise.all(pages.map(p=>p.evaluate(()=>window.clockProof)));await writeFile(`${out}/raw.json`,JSON.stringify({proofs,errors},null,2));
 for(const proof of proofs){assert.ok(proof.intervals.length>=2,'Two repeated result-to-flight measurements');for(const t of proof.intervals)assert.ok(t.ms>=28000&&t.ms<=32000,`Result-to-flight ${t.ms}ms`);assert.ok(proof.draws.some(d=>d.participated&&d.verified));}
 const common=proofs[0].draws.filter(d=>proofs[1].draws.some(e=>e.roundId===d.roundId));assert.ok(common.length);for(const d of common){const e=proofs[1].draws.find(e=>e.roundId===d.roundId);assert.equal(d.drawnBall,e.drawnBall);assert.equal(d.ballCount,e.ballCount);}
 await pages[0].locator('#autoTargetInput').fill('2.5');await pages[0].locator('#autoTargetInput').dispatchEvent('change');assert.equal(await pages[0].locator('.invite-repeat').getAttribute('aria-pressed'),'false');assert.deepEqual(errors,[]);
 await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,proofs,errors},null,2));console.log(JSON.stringify({passed:true,intervals:proofs.map(p=>p.intervals),errors}));
}finally{await browser.close();}
