import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2]||'work/native-action-frames'; await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[],events=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});
 await page.goto('http://localhost:3021/charmville/tutorial/');
 await page.getByRole('button',{name:'Enter the world',exact:true}).click();await page.waitForTimeout(11000);
 async function tap(){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(850);}
 async function action(name){
   await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');
   await page.screenshot({path:out+'/'+name+'-windup.png'});
   await page.waitForTimeout(240);await page.screenshot({path:out+'/'+name+'-contact.png'});
   await page.waitForTimeout(180);await page.screenshot({path:out+'/'+name+'-recovery.png'});
   await page.waitForTimeout(900);
 }
 await tap();await tap();await action('hoe');await tap();await action('water');
 assert(events.some(e=>e.includes('CHARMVILLE_CROP_STAGE 3')));assert.deepEqual(errors,[]);
 await writeFile(out+'/verification.json',JSON.stringify({errors,events,scope:'Native starting-facing action frames. Other facings are atlas-validated separately.'},null,2));
 console.log('Native hoe/water action sequence verified: '+out);
}finally{await browser.close();}
