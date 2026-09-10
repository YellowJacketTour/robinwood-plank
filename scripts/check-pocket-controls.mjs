import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(process.argv[2]||'work/pocket-controls');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 await page.locator('.console-menu').click();assert.ok(await page.locator('.console-tools').evaluate(e=>e.open));
 await page.keyboard.press('Escape');assert.equal(await page.locator('.console-tools').evaluate(e=>e.open),false);
 assert.equal(await page.locator('.console-menu').evaluate(e=>e===document.activeElement),true);
 await page.locator('.console-menu').click();await page.locator('#simBtn').click();
 await page.waitForFunction(()=>!document.querySelector('#autoTargetInput').disabled&&Number(document.querySelector('#substatus').textContent.match(/(\d+)s/)?.[1]||0)>18,null,{timeout:60000});
 // Close the drawer before testing the visible physical controls.
 await page.keyboard.press('Escape');
 const lower=page.getByRole('button',{name:'Lower stake'}),higher=page.getByRole('button',{name:'Higher stake'}),quote=page.locator('.pocket-stake-picker output');
 await page.waitForFunction(()=>!document.querySelector('.pocket-stake-picker button:last-child').disabled);
 while(!(await lower.isDisabled()))await lower.click();
 const first=await quote.textContent();assert.match(first,/Ξ.*ETH/);assert.match(first,/≈ \$/);
 await higher.focus();await page.keyboard.press('Enter');assert.notEqual(await quote.textContent(),first);
 await lower.click();assert.equal(await quote.textContent(),first);assert.ok(await lower.isDisabled());
 const target=page.locator('#autoTargetInput');await target.fill('1.01');await target.dispatchEvent('change');await target.blur();
 assert.equal(await target.inputValue(),'1.01');
 await target.fill('1.001');await target.dispatchEvent('input');assert.equal(await target.inputValue(),'1.001');assert.ok(await page.locator('#primaryBtn').isDisabled());
 await target.fill('1.01');await target.dispatchEvent('change');assert.equal(await target.getAttribute('aria-invalid'),'false');assert.equal(await target.getAttribute('aria-describedby'),'targetRiskHelp');
 // The disclosure must open and remain dismissible from the keyboard.
 await page.locator('.console-menu').click();await page.locator('.console-rules summary').click();
 assert.ok(await page.locator('#targetRiskHelp').isVisible());await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Open lottery machine'}).click();
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre canvas')?.dataset.phase==='presented',null,{timeout:60000});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.lottery-theatre').evaluate(e=>e.open),false);
 await page.evaluate(()=>document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:'Empty fixture',verified:true,participated:true,ballCount:'0',drawnBall:'0',nextPrize:'0.000001',testFunds:true}})));
 await page.waitForFunction(()=>document.querySelector('#lotteryTitle')?.textContent==='Prize is building');
 assert.equal(await page.locator('.lottery-theatre canvas').count(),0);assert.equal(await page.locator('#lotteryTitle').textContent(),'Prize is building');assert.ok(await page.locator('.lottery-funding-icon').isVisible());await page.keyboard.press('Escape');
 await page.screenshot({path:resolve(output,'controls.png')});assert.deepEqual(errors,[]);
 const proof={passed:true,stakePointerAndKeyboard:true,stakeBounds:true,ethAndUsdVisible:true,target101Accepted:true,menuEscapeRestoresFocus:true,expandedRulesVisible:true,invalidTargetBlocksBet:true,unfundedDrawHasNoFakeBall:true,lotteryEscape:true,errors};
 await writeFile(resolve(output,'controls-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}
