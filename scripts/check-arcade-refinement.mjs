import {chromium,firefox,webkit} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const output=resolve(process.argv[2]||'work/refinement');await mkdir(output,{recursive:true});
const browserType={chromium,firefox,webkit}[process.env.PLANK_BROWSER||'chromium'];if(!browserType)throw Error('Unknown browser');
const browser=await browserType.launch({headless:true,...(browserType===chromium?{args:['--use-angle=swiftshader']}:{} )});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/shader|WebGLProgram|GL_INVALID/.test(m.text()))errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 await page.getByRole('button',{name:'Open lottery machine'}).click();
 const canvas=page.locator('.lottery-theatre canvas');
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.renderState==='idle',null,{timeout:60000});
 const settled=await canvas.evaluate(c=>({...c.dataset}));assert.ok(Number(settled.batchedMeshes)>10);
 await page.waitForTimeout(800);assert.equal(await canvas.getAttribute('data-render-frame'),settled.renderFrame,'settled presentation must stop rendering');
 await page.screenshot({path:resolve(output,'machine-mobile.png')});
 await page.setViewportSize({width:1100,height:900});await page.waitForTimeout(500);
 assert.ok(Number(await canvas.getAttribute('data-render-frame'))>Number(settled.renderFrame),'resize must repaint idle scene');
 await page.screenshot({path:resolve(output,'machine-desktop.png')});
 await page.locator('.lottery-next').click();
 await page.emulateMedia({reducedMotion:'reduce'});
 for(let i=0;i<8;i++){
  await page.getByRole('button',{name:'Open lottery machine'}).click();
  await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.renderState==='idle',null,{timeout:30000});
  assert.equal(await page.locator('.lottery-theatre canvas').count(),1);
  assert.equal(await page.locator('.lottery-theatre').getAttribute('data-reveal'),'presented');
  await page.locator('.lottery-next').click();
 }
 await page.getByRole('button',{name:'Open lottery machine'}).click();
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.renderState==='idle');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForTimeout(200);
 assert.equal(await page.locator('.lottery-theatre canvas').getAttribute('data-phase'),'presented','turning motion back on must not rewind the draw');
 assert.equal(await page.locator('.lottery-theatre canvas').getAttribute('data-render-state'),'idle');
 await page.locator('.lottery-theatre canvas').evaluate(c=>c.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
 await page.waitForFunction(()=>document.querySelector('.lottery-status')?.textContent.includes('Animation unavailable'));
 assert.equal(await page.locator('.lottery-collect').isVisible(),false,'render failure must not invent a collectible prize');
 await page.locator('.lottery-next').click();
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:390,height:844});
 const before=await page.locator('#fx').getAttribute('data-render-frame');await page.waitForTimeout(600);
 assert.ok(Number(await page.locator('#fx').getAttribute('data-render-frame'))>Number(before),'main renderer must survive repeated theatre disposal');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('plank:explore')));
 await page.waitForFunction(()=>Number(document.querySelector('.stage')?.dataset.altitude)>.35,null,{timeout:30000});
 await page.screenshot({path:resolve(output,'flight-smoke.png')});
 assert.match(await page.locator('#substatus').textContent(),/preview.*no wager/i);
 const viewports=[];
 for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1280,height:800}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(200);
  const measured=await page.evaluate(()=>{const b=document.querySelector('#primaryBtn').getBoundingClientRect();return{scrollWidth:document.documentElement.scrollWidth,button:{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};});
  assert.ok(measured.scrollWidth<=viewport.width+1,`horizontal overflow at ${viewport.width}`);
  assert.ok(measured.button.right<=viewport.width+1&&measured.button.bottom<=viewport.height+1,`primary action offscreen at ${viewport.width}x${viewport.height}`);
  assert.ok(measured.button.width>=44&&measured.button.height>=44);
  viewports.push({viewport,...measured});
  if(viewport.width===320||viewport.height===390)await page.screenshot({path:resolve(output,`controls-${viewport.width}.png`)});
 }
 assert.deepEqual(errors,[]);
 const result={passed:true,renderer:`Headless ${browserType.name()} on Windows${browserType===chromium?' (SwiftShader)':''}; not physical-device FPS certification`,settled,reducedMotionCycles:8,contextLossFallback:true,mainRendererResumed:true,viewports,errors};
 await writeFile(resolve(output,'lifecycle-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
