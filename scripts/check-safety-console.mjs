import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=process.argv[2];
if(!root)throw Error('Pass an output workspace containing work/safety-operator-manifest.json. Use an isolated fixture, never the player preview manifest.');
const manifest=JSON.parse((await readFile(`${root}/work/safety-operator-manifest.json`,'utf8')).replace(/^\uFEFF/,''));
const rpc=async(method,params=[])=>{const j=await(await fetch('http://127.0.0.1:8545',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(j.error)throw Error(j.error.message);return j.result;};
const accounts=await rpc('eth_accounts');let account=accounts[0];
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/deploy-addresses.local.json',r=>r.fulfill({json:manifest}));
 await page.exposeFunction('walletRequest',({method,params})=>method==='eth_accounts'||method==='eth_requestAccounts'?[account]:rpc(method,params));
 await page.addInitScript(()=>{window.ethereum={request:args=>window.walletRequest(args),on(){},removeListener(){}};});
 await page.goto('http://127.0.0.1:8765/arcade/safety.html');
 await page.waitForFunction(()=>!document.querySelector('#freeze').disabled);
 await page.locator('#freeze').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='Confirmed on chain.');
 await page.waitForFunction(()=>document.querySelector('#state').textContent.includes('frozen')); 
 account=accounts[1];await page.locator('#reopen').click();await page.waitForFunction(()=>document.querySelector('#state').textContent.includes('reopening available'));
 await page.locator('#reopen').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('delay has not elapsed'));
 await page.screenshot({path:`${root}/outputs/plankcrash-safety-controls.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 await writeFile(`${root}/outputs/plankcrash-safety-browser.json`,JSON.stringify({passed:true,chainId:31337,isolatedCrash:manifest.crash,checks:['guardian freeze transaction','governance scheduled reopening transaction','early reopening rejected','390px no horizontal overflow','no page errors'],mainnetMultisigTested:false},null,2));
 console.log('Safety browser checks passed');
}finally{await browser.close();}

