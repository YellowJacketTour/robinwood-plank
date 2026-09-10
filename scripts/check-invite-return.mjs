import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='https://keep-heads-questionnaire-okay.trycloudflare.com';
const token=(await readFile('C:/Users/k1rby/Documents/Codex/2026-09-09/find/work/invite/invite-token.txt','utf8')).trim();
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const ctx=await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 for(let i=0;i<2;i++){
  await p.goto(`${base}/#invite=${token}`);await p.waitForURL('**/arcade/crash.html');
  await p.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address&&window.__plankCamera,null,{timeout:60000});
  assert.equal(await p.locator('.pocket-actions').count(),1);
 }
 await p.bringToFront();await p.locator('.invite-copy').click();
 const copied=await p.evaluate(()=>Promise.race([navigator.clipboard.readText(),new Promise((_,r)=>setTimeout(()=>r(Error('Clipboard timeout')),8000))]));assert.equal(copied,`${base}/#invite=${token}`);
 await p.screenshot({path:'C:/Users/k1rby/Documents/Codex/2026-09-09/find/outputs/invite-return-fixed.png'});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,url:p.url(),copied:true,returningSession:true,errors}));
}finally{await browser.close();}
