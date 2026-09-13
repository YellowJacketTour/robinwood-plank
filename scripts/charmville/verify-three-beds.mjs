import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out=process.argv[2]||'work/three-bed-lifecycle';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1000,height:850}}),events=[],errors=[];let pose;
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});
 page.on('websocket',socket=>socket.on('framesent',f=>{const values=String(f.payload).split('|');if(values[0]==='world')pose={x:Number(values[2]),y:Number(values[3])};}));
 await page.goto('http://localhost:3021/charmville/tutorial/');await page.getByRole('button',{name:'Enter the world',exact:true}).click();
 await page.waitForTimeout(11000);
 async function tap(){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(850);}
 async function work(){
  const before=events.filter(e=>e.includes('CHARMVILLE_ACTION_COMPLETE')).length;
  await tap();for(let poll=0;poll<40;poll++){
   if(events.filter(e=>e.includes('CHARMVILLE_ACTION_COMPLETE')).length>before)return;
   await page.waitForTimeout(100);
  }
  await writeFile(out+'/failed-action.json',JSON.stringify({events,pose},null,2));throw Error('Native action did not complete');
 }
 async function go(x){
  for(let attempt=0;attempt<30;attempt++){
   assert(pose,'native pose telemetry unavailable');if(Math.abs(pose.x-x)<=4){await page.waitForTimeout(350);return;}
   const direction=pose.x<x?'ArrowRight':'ArrowLeft';await page.keyboard.down(direction);await page.waitForTimeout(50);await page.keyboard.up(direction);await page.waitForTimeout(120);
  }
  throw Error('Native collision prevented reaching bed at '+x+'; last pose '+JSON.stringify(pose));
 }
 await tap();await tap();await page.screenshot({path:out+'/three-empty-beds.png'});
 for(let bed=1;bed<=3;bed++){
  await go(16+(bed-1)*32);await work();await work();await work();
  await writeFile(out+'/progress.json',JSON.stringify({events,errors,pose},null,2));await page.screenshot({path:out+'/current.png'});
  assert(events.some(e=>e.includes('CHARMVILLE_CROP_STAGE 3 BED '+bed)),'Bed '+bed+' must independently water');
  await page.screenshot({path:out+'/bed-'+bed+'-watered.png'});
 }
 await page.waitForTimeout(5500);await page.screenshot({path:out+'/three-ripe-beds.png'});
 for(let bed=1;bed<=3;bed++){
  assert(events.some(e=>e.includes('CHARMVILLE_CROP_READY BED '+bed)));
  await go(16+(bed-1)*32);await work();
 }
 assert(events.some(e=>e.includes('CHARMVILLE_SATCHEL BERRIES 3 CUTTINGS 3')));
 assert.deepEqual(errors,[]);await page.screenshot({path:out+'/three-harvests.png'});
 await writeFile(out+'/verification.json',JSON.stringify({events,errors,pose},null,2));console.log('All three beds reached, planted, watered, grown and harvested through native controls.');
}finally{await browser.close();}
