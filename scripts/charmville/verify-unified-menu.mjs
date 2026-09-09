import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:600,height:900}});
 await page.goto('http://localhost:3021/charmville/tutorial/');
 await page.getByRole('button',{name:'Enter the world',exact:true}).click();await page.waitForTimeout(12000);
 await page.locator('canvas').click();await page.keyboard.press('d');await page.waitForTimeout(700);await page.keyboard.press('d');await page.waitForTimeout(700);
 await page.evaluate(()=>{window.nativeEnterEvents=[];for(const type of ['keydown','keyup'])document.addEventListener(type,event=>{if(event.key==='Enter')window.nativeEnterEvents.push(type);});});
 await page.keyboard.press('Enter');
 const menu=page.getByRole('dialog',{name:'Game menu',exact:true});await menu.waitFor({state:'visible'});
 for(const name of ['Party','Gear','Inventory','Charmdex','Exchange','Friends','Voice notes'])assert(await menu.getByRole('button',{name,exact:true}).isVisible());
 assert.deepEqual(await page.evaluate(()=>window.nativeEnterEvents),['keyup']); // release of any previously held key, never a native pause down
 await mkdir('work/unified-menu',{recursive:true});await page.screenshot({path:'work/unified-menu/menu.png'});
 await menu.getByRole('button',{name:'Gear',exact:true}).click();await page.waitForTimeout(1000);
 assert(await menu.isHidden());
 assert.deepEqual((await page.evaluate(()=>window.nativeEnterEvents)).slice(-2),['keydown','keyup']);
 await page.screenshot({path:'work/unified-menu/native-gear.png'});
 await page.keyboard.press('Enter');await page.waitForTimeout(300);assert(await menu.isHidden());
 await page.keyboard.press('Enter');await menu.waitFor({state:'visible'});
 await menu.getByRole('button',{name:'Charmdex',exact:true}).click();
 await page.getByRole('button',{name:'Close Charmdex',exact:true}).waitFor({state:'visible'});
 await page.getByRole('searchbox',{name:'Search Charmdex'}).fill('cow');await page.keyboard.press('Enter');assert(await menu.isHidden());
 await page.getByRole('button',{name:'Close Charmdex',exact:true}).click();
 await page.locator('canvas').click();await page.keyboard.press('Enter');await menu.waitFor({state:'visible'});
 await menu.getByRole('button',{name:'Voice notes',exact:true}).click();await page.getByRole('button',{name:'Close voice note',exact:true}).waitFor({state:'visible'});
 await page.getByRole('button',{name:'Close voice note',exact:true}).click();await page.locator('canvas').click();await page.keyboard.press('Enter');await menu.waitFor({state:'visible'});
 await page.setViewportSize({width:390,height:844});assert((await menu.boundingBox()).width<=390);await page.screenshot({path:'work/unified-menu/menu-mobile.png'});
 assert.equal(await menu.getByRole('button',{name:'Home management',exact:true}).count(),0);
 const opening=page.context().waitForEvent('page');await menu.getByRole('button',{name:'Party',exact:true}).click();
 const party=await opening;await party.waitForURL('http://localhost:3017/charmville/world?panel=companions');
 assert(page.url().startsWith('http://localhost:3021/play/'));
 console.log('PASS Enter unified menu, native Gear forwarding, no native pause leakage, catalogue typing, Party destination');
}finally{await browser.close();}
