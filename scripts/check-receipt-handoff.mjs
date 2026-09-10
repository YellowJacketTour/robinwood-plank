import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const p=await browser.newPage({viewport:{width:390,height:844}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
 await p.goto(`http://127.0.0.1:8766/#invite=${token}`);
 await p.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 await p.evaluate(()=>{window.handoff=[];setInterval(()=>{window.handoff.push({t:performance.now(),card:document.querySelector('#resultCard')?.classList.contains('show'),open:!!document.querySelector('.lottery-theatre[open]'),phase:document.querySelector('.stage')?.dataset.presentation});},16);});
 await p.locator('.invite-repeat').click();
 await p.waitForFunction(()=>window.handoff.some(s=>s.card),null,{timeout:180000});
 await p.waitForFunction(()=>{const i=window.handoff.findIndex(s=>s.card);return window.handoff.slice(i).some(s=>s.open&&!s.card);},null,{timeout:15000});
 const samples=await p.evaluate(()=>window.handoff);const start=samples.findIndex(s=>s.card),after=samples.slice(start),end=after.findIndex(s=>s.open&&!s.card);
 assert.ok(after.slice(0,end).every(s=>s.card||s.open),'No blank beat after receipt');
 const duration=after[end].t-after[0].t;assert.ok(duration<4000,`Handoff took ${duration}ms`);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,receiptToMachineMs:duration,emptyFrames:0,errors}));
}finally{await browser.close();}
