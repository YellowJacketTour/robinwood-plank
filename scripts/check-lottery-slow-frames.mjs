import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2];await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 await page.evaluate(()=>{
  const native=requestAnimationFrame.bind(window);
  window.requestAnimationFrame=callback=>native(()=>setTimeout(()=>callback(performance.now()),180));
  window.slowFrames={phases:[],started:null,finished:null};
  const poll=setInterval(()=>{const c=document.querySelector('.lottery-theatre canvas');if(!c)return;const p=c.dataset.phase;
   if(p==='mixing'&&window.slowFrames.started===null)window.slowFrames.started=performance.now();
   if(p&&!window.slowFrames.phases.includes(p))window.slowFrames.phases.push(p);
   if(p==='presented'){window.slowFrames.finished=performance.now();clearInterval(poll);}
  },25);
  document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:'Slow-frame fixture',participated:true,verified:true,ballCount:'1000000',drawnBall:'987654',hit:false,nextPrize:'0.01'}}));
 });
 await page.waitForFunction(()=>window.slowFrames.finished!==null,null,{timeout:60000});
 await page.locator('.lottery-theatre-head').click();
 const proof=await page.evaluate(()=>({...window.slowFrames,scene:{...document.querySelector('.lottery-theatre canvas').dataset}}));
 const duration=proof.finished-proof.started;assert.ok(duration<6500,`Reveal stretched to ${duration}ms`);
 for(const p of ['mixing','chute','rolling','orienting','presented'])assert.ok(proof.phases.includes(p));
 assert.equal(proof.scene.visiblePopulation,'96');assert.deepEqual(errors,[]);
 await page.screenshot({path:`${out}/six-digit-closeup.png`});await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,artificialFrameDelayMs:180,duration,...proof,errors},null,2));console.log(JSON.stringify({passed:true,duration,phases:proof.phases,errors}));
}finally{await browser.close();}
