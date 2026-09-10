import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const output=resolve(process.argv[2]);await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>window.__plankCamera&&Math.abs(window.__plankCamera.clearance)<1e-6);
 const baseline=await page.evaluate(()=>window.__plankCamera);
 await page.evaluate(()=>document.dispatchEvent(new Event('plank:explore')));
 const samples=[];
 for(const height of [.2,1,3,8]){
  await page.waitForFunction(h=>window.__plankCamera?.clearance>=h,height,{timeout:30000});
  const sample=await page.evaluate(()=>({...window.__plankCamera,top:window.__plankRocketScreen().top,statusBottom:document.querySelector('#substatus').getBoundingClientRect().bottom}));
  assert.equal(sample.padVisible,true);assert.equal(sample.padY,baseline.padY);
  assert.ok(sample.top>sample.statusBottom,`avatar crossed readout: ${JSON.stringify(sample)}`);
  samples.push(sample);await page.screenshot({path:resolve(output,`ascent-${height}.png`)});
 }
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,'framing-proof.json'),JSON.stringify({passed:true,mode:'no-wager visual preview',baseline,samples,errors},null,2));
}finally{await browser.close();}
