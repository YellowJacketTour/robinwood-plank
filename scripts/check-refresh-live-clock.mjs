import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root='C:/Users/k1rby/Documents/Codex/2026-09-09/find',base='https://keep-heads-questionnaire-okay.trycloudflare.com',token=(await readFile(`${root}/work/invite/invite-token.txt`,'utf8')).trim();
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const p=await browser.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(`${base}/#invite=${token}`);
 await p.waitForFunction(()=>window.__plankLaunch&&((window.__plankLaunch.elapsed<0)||(window.__plankLaunch.elapsed>1400&&window.__plankLaunch.remainingFlightMs>7000)),null,{timeout:240000});
 const before=await p.evaluate(()=>({...window.__plankLaunch,at:Date.now()}));
 await p.reload();await p.waitForFunction(round=>window.__plankLaunch?.round===round,before.round,{timeout:20000});
 const after=await p.evaluate(()=>({...window.__plankLaunch,at:Date.now(),progress:window.__plankFlight}));
 assert.equal(after.liftoff,before.liftoff);assert.ok(after.elapsed>before.elapsed,'Clock advances through refresh');
 assert.ok(Math.abs((after.elapsed-before.elapsed)-(after.at-before.at))<1800,'Elapsed time survives reload');
 assert.equal(await p.locator('.invite-repeat').getAttribute('aria-pressed'),'false');assert.deepEqual(errors,[]);
 await writeFile(`${root}/outputs/refresh-live-proof.json`,JSON.stringify({passed:true,before,after,errors},null,2));console.log(JSON.stringify({passed:true,before,after,errors}));
}finally{await browser.close();}
