import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/arcade/crash.html?physicsDebug=1');
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('plank:lottery-prepare',{detail:{roundId:'prepared',ballCount:'500000',drawnBall:'173429'}})));
 await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].some(c=>c.dataset.population==='500000'&&c.dataset.renderFrame),null,{timeout:20000});
 const before=await page.evaluate(()=>{const c=[...document.querySelectorAll('canvas')].find(c=>c.dataset.population==='500000');window.preparedCanvas=c;return{elapsed:c.dataset.elapsed,open:!!document.querySelector('.lottery-theatre[open]'),snapshot:c.dataset.chamberSnapshot};});
 assert.equal(before.elapsed,'0.000');assert.equal(before.open,false);assert.ok(JSON.parse(before.snapshot).length>0);
 await page.waitForTimeout(1000);
 assert.equal(await page.evaluate(()=>window.preparedCanvas.dataset.elapsed),'0.000');
 await page.evaluate(()=>{window.firstVisible=null;const d=document.querySelector('.lottery-theatre');new MutationObserver(()=>{if(d.open&&!window.firstVisible)window.firstVisible={physics:d.querySelector('canvas')?.dataset.physics,snapshot:d.querySelector('canvas')?.dataset.chamberSnapshot};}).observe(d,{attributes:true,attributeFilter:['open']});document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:'prepared',participated:true,verified:true,hit:false,ballCount:'500000',drawnBall:'173429',nextPrize:'0'}}));});
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre')?.dataset.reveal==='presented',null,{timeout:20000});
 const result=await page.evaluate(()=>({same:window.preparedCanvas===document.querySelector('.lottery-theatre canvas'),first:window.firstVisible,phase:window.preparedCanvas.dataset.phase}));
 assert.ok(result.same);assert.equal(result.first.physics,'rapier');assert.ok(JSON.parse(result.first.snapshot).length>0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,...result,first:{physics:result.first.physics,bodies:JSON.parse(result.first.snapshot).length}}));
}finally{await browser.close();}
