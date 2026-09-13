import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
try {
 const page=await browser.newPage();
 await page.setContent('<header><button data-charmdex-open>Charmdex</button></header><dialog class="charmdex"><button id="one">First</button><button id="two">Second</button><select><option>A</option><option>B</option></select></dialog>');
 await page.evaluate(()=>{
  window.pad={connected:true,id:'Fixture',mapping:'standard',buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]};
  navigator.getGamepads=()=>[window.pad];window.events=[];window.clicks=0;
  document.addEventListener('keydown',e=>window.events.push(e.key));
  document.querySelector('[data-charmdex-open]').onclick=()=>document.querySelector('dialog').showModal();
  document.querySelector('#two').onclick=()=>window.clicks++;
 });
 await page.addScriptTag({content:await readFile(new URL('./controller-controls.js',import.meta.url),'utf8')});
 const set=async(i,value)=>{await page.evaluate(([i,value])=>window.pad.buttons[i].pressed=value,[i,value]);await page.waitForTimeout(80);};
 const tap=async i=>{await set(i,true);await set(i,false);};
 await page.waitForTimeout(80);await tap(0);assert.deepEqual(await page.evaluate(()=>window.events),['z']);
 await page.evaluate(()=>window.events=[]);await tap(8);assert(await page.locator('dialog').evaluate(el=>el.open));
 await tap(13);assert.equal(await page.evaluate(()=>document.activeElement.id),'two');
 await set(0,true);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.clicks),1);await set(0,false);
 await tap(13);await tap(15);assert.equal(await page.locator('dialog select').inputValue(),'B');
 await set(1,true);assert.equal(await page.locator('dialog').evaluate(el=>el.open),false);await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.events),[]);await set(1,false);
 await tap(0);assert.deepEqual(await page.evaluate(()=>window.events),['z']);
 await set(0,true);await page.evaluate(()=>{window.pad.connected=false;window.events=[];});await page.waitForTimeout(80);await page.evaluate(()=>window.pad.connected=true);await page.waitForTimeout(80);assert.deepEqual(await page.evaluate(()=>window.events),[]);await set(0,false);await tap(0);assert.deepEqual(await page.evaluate(()=>window.events),['z']);
 await tap(8);await page.evaluate(()=>{const original=document.querySelector('dialog');const voice=document.createElement('dialog');voice.className='voice-notes';voice.innerHTML='<button>Record</button>';document.body.append(voice);window.recordings=0;voice.firstElementChild.onclick=()=>window.recordings++;document.querySelector('#one').onclick=()=>{original.close();voice.showModal();};document.querySelector('#one').focus();});await set(0,true);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.recordings),0);await set(0,false);await tap(0);assert.equal(await page.evaluate(()=>window.recordings),1);
 console.log('PASS controller modal focus, select, confirm edge, back, native isolation, reconnect neutral gate');
}finally{await browser.close();}


