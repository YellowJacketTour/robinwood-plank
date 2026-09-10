import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const p=await browser.newPage({viewport:{width:390,height:844}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
 await p.goto(`http://127.0.0.1:8766/#invite=${token}`);
 await p.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 await p.evaluate(()=>{window.timing=[];setInterval(()=>{window.timing.push({t:performance.now(),text:document.querySelector('#substatus')?.textContent,phase:document.querySelector('.stage')?.dataset.presentation,alt:Number(document.querySelector('.stage')?.dataset.altitude)});},20);});
 await p.waitForFunction(()=>window.timing.some(s=>s.text==='Launch in 3'),null,{timeout:90000});
 await p.waitForFunction(()=>{const i=window.timing.findIndex(s=>s.text==='Launch in 3');return window.timing.slice(i).some(s=>s.phase==='crash');},null,{timeout:65000});
 const samples=await p.evaluate(()=>window.timing);assert.ok(!samples.some(s=>/Result in about|Bets close in/.test(s.text)));const first=samples.findIndex(s=>s.text==='Launch in 3');const seq=samples.slice(first);const flight=seq.find(s=>s.alt>0&&s.phase==='flight');
 for(const n of [3,2,1])assert.ok(seq.some(s=>s.text===`Launch in ${n}`));
 assert.ok(seq.filter(s=>/^Launch in/.test(s.text)).every(s=>s.alt===0));
 if(flight)assert.ok(flight.t-seq[0].t>=2700&&flight.t-seq[0].t<3700);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,countdown:[3,2,1],liftoffDelay:flight?flight.t-seq[0].t:null,errors}));
}finally{await browser.close();}
