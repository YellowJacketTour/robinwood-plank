import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  window.cycleCheck={frames:[],draws:[]};
  document.addEventListener('plank:lottery-result',e=>window.cycleCheck.draws.push(e.detail));
  function frame(){const stage=document.querySelector('.stage');if(stage&&window.cycleCheck.frames.length<20000)window.cycleCheck.frames.push({phase:stage.dataset.presentation,altitude:Number(stage.dataset.altitude||0),round:document.querySelector('#roundLabel')?.textContent,status:document.querySelector('#substatus')?.textContent});requestAnimationFrame(frame);}requestAnimationFrame(frame);
 });
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.locator('#simBtn').evaluate(button=>button.click());
 // Each local round includes 20s betting plus the contract's 20 x 3s
 // randomness safety margin. Two complete rounds need more than 150s.
 const deadline=Date.now()+240000, transitions=[];
 while(Date.now()<deadline){
  const modal=page.locator('.lottery-theatre[open]');
  if(await modal.count()) await page.getByRole('button',{name:'Back to flight',exact:true}).click();
  const primary=page.locator('#primaryBtn');
  const label=await primary.textContent();
  const state=await page.locator('#roundLabel').textContent()+':'+label;
  if(transitions.at(-1)!==state){transitions.push(state);console.log(state);}
  // Resolve the phase and dispatch in one browser task: a deadline can disable
  // the control between separate isEnabled()/click() protocol round trips.
  await primary.evaluate(button=>{if(!button.disabled&&/^(launch|play|bet)/i.test(button.textContent.trim()))button.click();});
  const draws=await page.evaluate(()=>window.cycleCheck.draws.filter(d=>d.participated));
  if(draws.length>=2 && draws.some(d=>BigInt(d.ballCount||'0')>0n))break;
  await page.waitForTimeout(350);
 }
 const result=await page.evaluate(()=>window.cycleCheck);
 console.log(JSON.stringify({transitions,lastFrames:result.frames.slice(-3),draws:result.draws}));
 assert.deepEqual(errors,[]);
 const draws=result.draws.filter(d=>d.participated);
 assert.ok(draws.length>=2,`expected two played rounds; got ${draws.length}`);
 assert.ok(draws.every(d=>d.verified===true),'every presented result must verify');
 assert.ok(draws.some(d=>BigInt(d.ballCount||'0')>0n),'at least one funded numbered draw must be exercised');
 assert.equal(new Set(draws.map(d=>d.roundId)).size,draws.length,'no duplicate draw presentations');
 const flights=result.frames.filter(f=>f.phase==='flight');
 assert.ok(flights.some(f=>f.altitude>0),'flight must leave the pad');
 for(let i=1;i<result.frames.length;i++){
  const a=result.frames[i-1],b=result.frames[i];
  if(a.phase==='flight'&&b.phase==='flight'&&a.status===b.status)assert.ok(b.altitude>=a.altitude,'flight cannot move backward');
 }
 console.log(JSON.stringify({playedRounds:draws.map(d=>d.roundId),verifiedDraws:draws.length,flightFrames:flights.length,maximumAltitude:Math.max(...flights.map(f=>f.altitude)),errors}));
}finally{await browser.close();}
