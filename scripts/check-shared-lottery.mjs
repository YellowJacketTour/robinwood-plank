import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(process.argv[2]||'work/shared-lottery');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const results=[];
 for(const stake of ['1','3']){
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765/arcade/crash.html');
  await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
  await page.evaluate(myStake=>document.dispatchEvent(new CustomEvent('plank:lottery-result',{detail:{roundId:'Shared fixture',participated:true,verified:true,testFunds:true,hit:false,isWinner:false,myStake,roundStake:'4',ballCount:'16',drawnBall:'9',nextPrize:'0.0123456789'}})),stake);
  await page.waitForFunction(()=>document.querySelector('.lottery-theatre')?.dataset.reveal==='presented');
  const state=await page.evaluate(()=>({odds:document.querySelector('.lottery-personal-odds').textContent,amount:document.querySelector('.lottery-amount').title,ball:document.querySelector('.lottery-odds').textContent,scene:{...document.querySelector('.lottery-theatre canvas').dataset}}));
  assert.deepEqual(errors,[]);assert.match(state.odds,new RegExp(`Exact: ${stake} / 64`));
  results.push(state);await page.close();
 }
 for(const key of ['ball','amount'])assert.equal(results[0][key],results[1][key]);
 for(const key of ['population','visiblePopulation','ballPosition','ballRotation','phase'])assert.equal(results[0].scene[key],results[1].scene[key]);
 const proof={passed:true,kind:'presentation fixture, not chain-settlement proof',results};
 await writeFile(resolve(output,'shared-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:true,sharedResult:true,personalOdds:['1/64','3/64']}));
}finally{await browser.close();}
