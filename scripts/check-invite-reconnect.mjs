import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.PLANK_INVITE_URL,token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const out=resolve(process.env.PLANK_INVITE_OUTPUT);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/#invite=${token}`);
 await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 const address=await page.locator('.invite-player output').getAttribute('data-address');
 if(await page.locator('.invite-repeat').getAttribute('aria-pressed')==='true')await page.locator('.invite-repeat').click();
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 assert.equal(await page.locator('.invite-player output').getAttribute('data-address'),address);
 assert.equal(await page.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
 await page.waitForFunction(()=>document.querySelector('#communityFuelControl'),null,{timeout:30000});
 await page.locator('#communityFuelControl summary').click();
 const burn=page.locator('#communityFuelControl button');
 await page.waitForFunction(()=>!document.querySelector('#communityFuelControl button').disabled,null,{timeout:65000});
 await burn.click();
 await page.waitForFunction(()=>document.querySelector('#communityFuelControl')?.dataset.confirmed==='true',null,{timeout:30000});
 const fuel=await page.locator('#communityFuelControl p').textContent();
 await page.screenshot({path:resolve(out,'reconnect-fuel.png')});
 assert.deepEqual(errors,[]);
 await writeFile(resolve(out,'reconnect.json'),JSON.stringify({passed:true,address,pausePersisted:true,fuel,errors},null,2));console.log({passed:true,pausePersisted:true,fuel,errors});
}finally{await browser.close();}
