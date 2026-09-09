import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.argv[2]||'.charmville-reference-check');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 const errors=[],external=[],failures=[];
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(!['localhost','127.0.0.1'].includes(url.hostname)&&['http:','https:'].includes(url.protocol)){external.push(url.origin);return route.abort();}return route.continue();});
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
 await page.goto('http://localhost:3021/play/?open=quests/purezc/139&name=Charmville&storage=idb');
 await page.waitForFunction(()=>{const c=document.querySelector('canvas');return c?.width>300&&document.getElementById('status')?.hidden;},{},{timeout:30000});
 assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 await page.waitForTimeout(2500); // The engine animates name-entry after signaling Ready.
 await page.screenshot({path:path.join(output,'cold-start.png')});
 await page.keyboard.press('Tab');await page.keyboard.type('CHARM');await page.keyboard.press('Enter');
 await page.waitForTimeout(3000);await page.keyboard.press('Enter');await page.waitForTimeout(15000);
 await page.screenshot({path:path.join(output,'quest-start.png')});
 await page.reload();
 await page.waitForFunction(()=>document.getElementById('status')?.hidden,{},{timeout:30000});
 await page.screenshot({path:path.join(output,'warm-start.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(failures,[]);
 const receipt={result:'pass',checks:['Cold browser-storage startup','Original authored quest starts','Warm browser-storage reload','Cross-origin isolation','No external network requests, page errors or HTTP failures'],limitations:['Not a full quest/combat playthrough','Not multiplayer or farming integration']};
 await writeFile(path.join(output,'verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await browser.close();}
