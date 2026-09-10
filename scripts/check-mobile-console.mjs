import {chromium,firefox,webkit} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.env.PLANK_INVITE_OUTPUT;await mkdir(out,{recursive:true});
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const engine=process.env.PLANK_BROWSER||'chromium';
const browser=await ({chromium,firefox,webkit}[engine]).launch({headless:true,...(engine==='chromium'?{args:['--use-angle=swiftshader']}: {})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:engine!=='firefox',hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${process.env.PLANK_INVITE_URL}/#invite=${token}`);
 await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 if(await page.locator('.invite-repeat').getAttribute('aria-pressed')==='true')await page.locator('.invite-repeat').tap();
 const results=[];
 for(const [width,height] of [[320,568],[360,640],[390,844],[430,932],[768,1024],[844,390],[568,320]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(700);
  const result=await page.evaluate(()=>{
   const bounds=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
   return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,stage:bounds(document.querySelector('.stage')),primary:bounds(document.querySelector('#primaryBtn')),controls:[...document.querySelectorAll('.invite-player button,.pocket-stake-picker button,.console-menu,.lottery-open')].map(bounds),ratio:document.querySelector('#fx').dataset.renderRatio};
  });
  assert.ok(result.scrollWidth<=width+1,`horizontal overflow ${width}: ${JSON.stringify(result)}`);
  assert.ok(result.primary.bottom<=height+1,`primary below fold ${width}: ${JSON.stringify(result)}`);
  assert.ok(result.stage.width>200&&result.stage.height>=280);
  for(const c of result.controls){assert.ok(c.width>=44&&c.height>=44,`small touch target ${width}: ${JSON.stringify(c)}`);assert.ok(c.x>=0&&c.right<=width+1);}
  await page.locator('.console-menu').tap();assert.ok(await page.locator('.console-drawer').isVisible());await page.keyboard.press('Escape');
  await page.screenshot({path:`${out}/${width}x${height}.png`});results.push(result);
 }
 await page.setViewportSize({width:393,height:851});
 await page.getByRole('button',{name:'Open lottery machine'}).tap();
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented',null,{timeout:60000});
 const machine=await page.locator('.lottery-theatre canvas').evaluate(e=>({...e.dataset}));
 assert.ok(Number(machine.bufferResizes)<=3,JSON.stringify(machine));
 // Hold the result while rotating and scrolling; the close control stays reachable.
 await page.locator('.lottery-theatre-head').tap();
 await page.screenshot({path:`${out}/lottery.png`});
 await page.setViewportSize({width:851,height:393});await page.waitForTimeout(500);
 await page.locator('.lottery-theatre').evaluate(e=>{e.scrollTop=e.scrollHeight;});
 const close=page.locator('.lottery-theatre-head button');
 const closeBox=await close.boundingBox();assert.ok(closeBox.y>=0&&closeBox.y+closeBox.height<=393);
 await close.tap();assert.equal(await page.locator('.lottery-theatre').evaluate(e=>e.open),false);
 assert.deepEqual(errors,[]);await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,results,machine,errors},null,2));console.log(JSON.stringify({passed:true,results,machine}));
}finally{await browser.close();}
