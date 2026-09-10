import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.env.PLANK_INVITE_OUTPUT;await mkdir(out,{recursive:true});
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 await page.addInitScript(()=>{window.repeatProof={bets:[]};document.addEventListener('plank:bet-confirmed',()=>window.repeatProof.bets.push(performance.now()));});
 await page.goto(`${process.env.PLANK_INVITE_URL}/#invite=${token}`);
 await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 await page.locator('.invite-repeat').click();
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre[open]')?.dataset.reveal==='presented',null,{timeout:90000});
 await page.locator('.lottery-theatre').dispatchEvent('pointerdown');
 const before=await page.evaluate(()=>window.repeatProof.bets.length);
 await page.waitForTimeout(35000);
 const after=await page.evaluate(()=>window.repeatProof.bets.length);
 assert.equal(after,before,'Repeat must not bet through an open result');assert.ok(await page.locator('.lottery-theatre').evaluate(e=>e.open));
 await page.locator('.lottery-close').click();
 await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,heldMs:35000,betsBefore:before,betsAfter:after},null,2));console.log({passed:true,heldMs:35000,betsBefore:before,betsAfter:after});
}finally{await browser.close();}
