import {chromium,webkit,firefox} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2];await mkdir(out,{recursive:true});
const engine=process.env.PLANK_BROWSER||'chromium';
const browser=await ({chromium,webkit,firefox}[engine]).launch({headless:true,...(engine==='chromium'?{args:['--use-angle=swiftshader']}: {})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let stall=true;await page.route('**/lottery-physics-worker.js',route=>stall?route.fulfill({contentType:'text/javascript',body:'self.onmessage=()=>{};'}):route.continue());
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 await page.evaluate(()=>{window.recovery={presented:[],closed:[]};document.addEventListener('plank:lottery-presented',e=>window.recovery.presented.push(e.detail));document.addEventListener('plank:lottery-closed',e=>window.recovery.closed.push(e.detail));});
 const draw=round=>page.evaluate(round=>document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:round,participated:true,verified:true,ballCount:'500000',drawnBall:'499999',hit:false,nextPrize:'0.01'}})),round);
 await draw('stalled worker');
 await page.waitForFunction(()=>document.querySelector('.lottery-static-ball')?.textContent==='499999',null,{timeout:18000});
 await page.waitForFunction(()=>!document.querySelector('.lottery-theatre').open,null,{timeout:8000});
 stall=false;await draw('recovered worker');
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented',null,{timeout:15000});
 const thread=await page.locator('.lottery-theatre canvas').getAttribute('data-physics-thread');assert.equal(thread,'worker');
 await page.waitForFunction(()=>!document.querySelector('.lottery-theatre').open,null,{timeout:8000});
 const proof=await page.evaluate(()=>window.recovery);assert.equal(proof.presented.length,2);assert.equal(proof.closed.length,2);assert.deepEqual(errors,[]);
 await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,thread,...proof,errors},null,2));console.log(JSON.stringify({passed:true,thread,...proof,errors}));
}finally{await browser.close();}
