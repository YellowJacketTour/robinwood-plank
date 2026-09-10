import {chromium}from'@playwright/test';import assert from'node:assert/strict';import{mkdir,writeFile}from'node:fs/promises';
const out='C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/prize-physics';await mkdir(out,{recursive:true});const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{const page=await browser.newPage({viewport:{width:420,height:320}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});await page.goto('http://127.0.0.1:8765/arcade/prize-preview.html?value=0.0001');const results=[];
 for(const [tier,value]of ['0.0001','0.01','0.1','1','10','1000'].entries()){
  await page.evaluate(v=>{prizeFixture.prepare(v);prizeFixture.show()},value);await page.waitForFunction(()=>document.querySelector('canvas').dataset.ready==='true');await page.waitForTimeout(1300);
  const before=await page.evaluate(()=>({data:{...document.querySelector('canvas').dataset},poses:prizeFixture.snapshot()}));assert.equal(Number(before.data.tier),tier);assert.ok(Number(before.data.bodies)<=24);assert.ok(Number(before.data.drawCalls)<=12);
  await page.screenshot({path:`${out}/tier-${tier}.png`});await page.locator('canvas').focus();await page.keyboard.press('Enter');await page.waitForTimeout(300);const moved=await page.evaluate(()=>prizeFixture.snapshot());assert.ok(moved.some((n,i)=>Math.abs(n-before.poses[i])>.00001),'Real rigid-body response');
  await page.waitForTimeout(1900);const frames=await page.locator('canvas').getAttribute('data-frames');await page.waitForTimeout(300);assert.equal(await page.locator('canvas').getAttribute('data-frames'),frames,'No idle animation loop');results.push(before.data);
 }
 await page.evaluate(()=>prizeFixture.hide());const f=await page.locator('canvas').getAttribute('data-frames');await page.waitForTimeout(300);assert.equal(await page.locator('canvas').getAttribute('data-frames'),f);assert.deepEqual(errors,[]);await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,results,errors},null,2));console.log(JSON.stringify({passed:true,results,errors}));
}finally{await browser.close();}
