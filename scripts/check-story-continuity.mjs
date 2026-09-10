import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {id} from 'ethers';
import assert from 'node:assert/strict';
const base=process.env.PLANK_INVITE_URL||'http://127.0.0.1:8766';
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const out=resolve(process.env.PLANK_INVITE_OUTPUT);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
let delayedUntil=0,delayedRound=null,withheld=0,networkFailures=0;
await page.route('**/api/invite/rpc',async route=>{
 try{
 const response=await route.fetch({maxRetries:2});const payload=await response.json(),raw=route.request().postDataJSON();
 const requests=Array.isArray(raw)?raw:[raw],replies=Array.isArray(payload)?payload:[payload];
 for(const request of requests){
  const topics=request.params?.[0]?.topics;
  if(request.method!=='eth_getLogs'||topics?.[0]!==id('Draw(uint256,uint256,uint256,bool,address,uint256,uint256,uint256)')||!topics[1])continue;
  const reply=replies.find(r=>r.id===request.id);if(!reply?.result?.length)continue;
  if(!delayedRound){delayedRound=topics[1];delayedUntil=Date.now()+6000;}
  if(topics[1]===delayedRound&&Date.now()<delayedUntil){reply.result=[];withheld++;}
 }
 await route.fulfill({response,json:Array.isArray(payload)?replies:replies[0]});
 }catch{networkFailures++;try{await route.abort('failed');}catch{}}
});
await page.addInitScript(()=>{
 window.storyProof={starts:[],draws:[],closed:[],frames:[]};
 document.addEventListener('plank:flight-replay-start',e=>window.storyProof.starts.push({...e.detail,at:performance.now()}));
 document.addEventListener('plank:lottery-presented',e=>window.storyProof.draws.push({...e.detail,at:performance.now()}));
 document.addEventListener('plank:lottery-closed',e=>window.storyProof.closed.push({...e.detail,at:performance.now()}));
 setInterval(()=>{const s=document.querySelector('.stage');if(s)window.storyProof.frames.push({round:s.dataset.storyRound,owner:s.dataset.storyPhase,phase:s.dataset.presentation,label:document.querySelector('#roundLabel')?.textContent,at:performance.now()});},50);
});
try{
 await page.goto(`${base}/#invite=${token}`);
 await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 if(await page.locator('.invite-repeat').getAttribute('aria-pressed')!=='true')await page.locator('.invite-repeat').click();
 let held=false,lastCheckpoint=0;const deadline=Date.now()+300000;
 while(Date.now()<deadline){
  if(Date.now()-lastCheckpoint>15000){lastCheckpoint=Date.now();await writeFile(resolve(out,'progress.json'),JSON.stringify(await page.evaluate(()=>({starts:window.storyProof.starts,draws:window.storyProof.draws,closed:window.storyProof.closed,lastFrame:window.storyProof.frames.at(-1),status:document.querySelector('#substatus')?.textContent})),null,2));}
  if(await page.locator('.lottery-theatre[open][data-reveal="presented"]').count()){
   if(!held){
    held=true;await page.locator('.lottery-theatre').dispatchEvent('pointerdown');
    const before=await page.evaluate(()=>({count:window.storyProof.starts.length,round:document.querySelector('.stage').dataset.storyRound}));
    await page.screenshot({path:resolve(out,'lottery-held.png')});
    console.log('Holding lottery across the following round');
    await page.waitForTimeout(42000);
    const after=await page.evaluate(()=>({count:window.storyProof.starts.length,round:document.querySelector('.stage').dataset.storyRound}));
    assert.deepEqual(after,before,'No following flight may play underneath an open lottery');
   }
   await page.locator('.lottery-next').click();
  }
  if(await page.evaluate(()=>window.storyProof.draws.length)>=6)break;
  await page.waitForTimeout(250);
 }
 const proof=await page.evaluate(()=>window.storyProof);
 await writeFile(resolve(out,'raw-proof.json'),JSON.stringify(proof,null,2));
 assert.ok(held&&withheld>1,'Exercise held lottery and delayed draw reads');
 assert.ok(proof.draws.length>=6,`Six complete narratives required, got ${proof.draws.length}`);
 for(const start of proof.starts)assert.equal(proof.starts.filter(s=>s.roundId===start.roundId).length,1,'No duplicate flight');
 for(const frame of proof.frames){
  if(['flight','crash','lottery'].includes(frame.owner))assert.notEqual(frame.phase,'betting','A new book must not reset an unfinished story');
  if(frame.owner!=='idle'&&frame.round)assert.equal(frame.label,'ROUND '+frame.round,'Round label follows the story');
 }
 for(const draw of proof.draws){
  const start=proof.starts.find(s=>s.roundId===draw.roundId);assert.ok(start);
  assert.ok(proof.frames.some(f=>f.round===draw.roundId&&f.phase==='crash'&&f.at>start.at&&f.at<draw.at),'Crash precedes each lottery');
 }
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:1280,height:900});await page.waitForTimeout(500);await page.screenshot({path:resolve(out,'desktop-return.png')});
 await writeFile(resolve(out,'story-proof.json'),JSON.stringify({passed:true,withheld,held,networkFailures,errors,...proof},null,2));
 console.log({passed:true,rounds:proof.draws.map(d=>d.roundId),withheld,held,errors});
}finally{await browser.close();}
