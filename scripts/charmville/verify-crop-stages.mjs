import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.argv[2]||'.charmville-crop-check';await mkdir(out,{recursive:true});
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[],events=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().startsWith('CHARMVILLE_'))events.push(m.text());});
 await page.goto('http://localhost:3021/charmville/tutorial/');
 await page.getByRole('button',{name:'Enter the world',exact:true}).click();await page.waitForTimeout(11000);
 async function tap(){await page.keyboard.down('d');await page.waitForTimeout(150);await page.keyboard.up('d');await page.waitForTimeout(850);}
 async function capture(name){await page.screenshot({path:out+'/'+name+'.png'});}
 await tap();await tap();await tap();await capture('soil');await tap();await capture('seed');
 await tap();await capture('sprout');await page.waitForTimeout(1400);await capture('taller');
 await page.waitForTimeout(1600);await capture('flowering');await page.waitForTimeout(2000);await capture('ripe');
 await tap();await capture('harvested');
 await tap();await tap();await tap();await capture('fertilized');
 await tap(); // Repeated interaction must not consume another cutting.
 await page.waitForTimeout(4200);await tap();await capture('second-harvest');
 assert.equal(events.filter(e=>e.includes('CHARMVILLE_FERTILIZED')).length,1);
 assert(events.some(e=>e.includes('CHARMVILLE_SATCHEL BERRIES 3 CUTTINGS 1')));
 assert.deepEqual(errors,[]);for(const stage of [1,2,3])assert(events.some(e=>e.includes('CHARMVILLE_CROP_STAGE '+stage)));
 assert(events.some(e=>e.includes('CHARMVILLE_CROP_READY')));assert(events.some(e=>e.includes('CHARMVILLE_HARVEST 1')));
 await writeFile(out+'/verification.json',JSON.stringify({errors,events},null,2));console.log('Crop growth and harvest verified. Screenshots: '+out);
}finally{await browser.close();}
