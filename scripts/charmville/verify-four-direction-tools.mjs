import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2]||'work/four-direction-tools';await mkdir(out,{recursive:true});
const browser=await chromium.launch({args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const results=[];
try{
 for(const [name,dir,x,y] of [['down',1,24,72],['up',0,24,96],['left',2,36,88],['right',3,12,88]]){
  const page=await browser.newPage({viewport:{width:1000,height:850}}),events=[],errors=[];let pose;
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});
  page.on('websocket',socket=>socket.on('framesent',f=>{const v=String(f.payload).split('|');if(v[0]==='world')pose={x:Number(v[2]),y:Number(v[3])};}));
  await page.goto('http://localhost:3021/charmville/tutorial/');await page.getByRole('button',{name:'Enter the world',exact:true}).click();await page.waitForTimeout(11000);
  async function press(){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');}
  await press();await page.waitForTimeout(800);await press();await page.waitForTimeout(800);
  async function axis(key,target){
   for(let i=0;i<50;i++){
    assert(pose);if(Math.abs(pose[key]-target)<=1){await page.waitForTimeout(250);return;}
    const button=key==='x'?(pose.x<target?'ArrowRight':'ArrowLeft'):(pose.y<target?'ArrowDown':'ArrowUp');
    await page.keyboard.down(button);await page.waitForTimeout(30);await page.keyboard.up(button);await page.waitForTimeout(120);
   }
   throw Error(name+' cannot reach '+key+'='+target+': '+JSON.stringify(pose));
  }
  await axis('x',x);await axis('y',y);
  async function work(tool){
   const completed=events.filter(e=>e.includes('CHARMVILLE_ACTION_COMPLETE')).length;
   await press();if(tool)await page.screenshot({path:out+'/'+name+'-'+tool+'-sample-1.png'});
   await page.waitForTimeout(220);if(tool)await page.screenshot({path:out+'/'+name+'-'+tool+'-sample-2.png'});
   await page.waitForTimeout(180);if(tool)await page.screenshot({path:out+'/'+name+'-'+tool+'-sample-3.png'});
   for(let i=0;i<40&&events.filter(e=>e.includes('CHARMVILLE_ACTION_COMPLETE')).length===completed;i++)await page.waitForTimeout(100);
   assert(events.filter(e=>e.includes('CHARMVILLE_ACTION_COMPLETE')).length>completed,name+' action failed');
  }
  await work('hoe');await work();await work('water');
  for(const frame of [0,1,2,3,4,5,6,7])assert(events.includes(`CHARMVILLE_TOOL 0 DIR ${dir} FRAME ${frame}`),name+' missing hoe '+frame);
  for(const frame of [0,1,4,5])assert(events.includes(`CHARMVILLE_TOOL 2 DIR ${dir} FRAME ${frame}`),name+' missing water '+frame);
  assert.deepEqual(errors,[]);assert(!events.some(e=>e.includes('ACTION_CANCEL')));
  results.push({name,dir,pose,events,errors});await writeFile(out+'/verification.json',JSON.stringify(results,null,2));await page.close();
 }
 console.log('Four native directions emitted every selected hoe/watering frame and completed without cancellation.');
}finally{await browser.close();}
