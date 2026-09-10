import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(process.argv[2]||'work/preview-visibility');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:597,height:1238}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.previewHidden=true;
  Object.defineProperty(document,'hidden',{get:()=>window.previewHidden,configurable:true});
  Object.defineProperty(document,'visibilityState',{get:()=>window.previewHidden?'hidden':'visible',configurable:true});
 });
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 assert.equal(await page.locator('#fx').getAttribute('data-render-frame'),null);
 await page.evaluate(()=>{window.previewHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>Number(document.querySelector('#fx').dataset.renderFrame)>5);
 await page.screenshot({path:resolve(output,'restored-preview.png')});
 for (const width of [390,597,1280]) {
  await page.setViewportSize({width,height:width===1280?900:1238});
  const before=await page.locator('#fx').getAttribute('data-render-frame');
  await page.waitForFunction(n=>Number(document.querySelector('#fx').dataset.renderFrame)>Number(n)+3,before);
  const size=await page.locator('#fx').evaluate(c=>({width:c.width,height:c.height,clientWidth:c.clientWidth,clientHeight:c.clientHeight}));
  assert.ok(size.width>0&&size.height>0&&size.clientWidth>0&&size.clientHeight>0);
 }
 // Resume even when an embedding host omits the visibilitychange event.
 await page.evaluate(()=>{window.previewHidden=true;});await page.waitForTimeout(200);
 const paused=await page.locator('#fx').getAttribute('data-render-frame');
 await page.evaluate(()=>{window.previewHidden=false;});
 await page.waitForFunction(n=>Number(document.querySelector('#fx').dataset.renderFrame)>Number(n)+3,paused);
 assert.deepEqual(errors,[]);
 await writeFile(resolve(output,'verification.json'),JSON.stringify({passed:true,initiallyHidden:true,resumedWithEvent:true,resumedWithoutEvent:true,widths:[390,597,1280],pageErrors:errors},null,2));
 console.log('PASS: initially hidden preview resumes rendering, with or without a visibility event, at mobile, embedded and desktop sizes');
} finally {await browser.close();}
