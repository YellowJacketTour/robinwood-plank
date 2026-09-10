import {chromium} from '@playwright/test';

import {mkdir,writeFile,readFile} from 'node:fs/promises';

import {resolve} from 'node:path';

import {Contract,JsonRpcProvider,id as eventId} from 'ethers';

import assert from 'node:assert/strict';

const output=resolve(process.argv[2]||'work/public-loop');await mkdir(output,{recursive:true});

const rpc=new JsonRpcProvider('http://127.0.0.1:8545');assert.equal((await rpc.getNetwork()).chainId,31337n);

const manifest=JSON.parse(await readFile('public/arcade/deploy-addresses.local.json','utf8'));

const crash=new Contract(manifest.crash,JSON.parse(await readFile('public/arcade/abi/PlankCrash.json','utf8')),rpc);

assert.equal(await crash.bettingDurationSeconds(),30n);

const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});

try{

 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];

 page.on('pageerror',error=>errors.push(error.message));
 const delayDrawMs=Number(process.env.PLANK_DELAY_DRAW_MS||0);let delayedUntil=0,delayedRound=null,withheldDrawReads=0;
 if(delayDrawMs>0)await page.route('http://127.0.0.1:8545/**',async route=>{
  const response=await route.fetch();const payload=await response.json();const raw=route.request().postDataJSON();
  const requests=Array.isArray(raw)?raw:[raw],replies=Array.isArray(payload)?payload:[payload];
  for(const request of requests){
   const topics=request.params?.[0]?.topics;
   if(request.method!=='eth_getLogs'||topics?.[0]!==eventId('Draw(uint256,uint256,uint256,bool,address,uint256,uint256,uint256)')||!topics[1])continue;
   const reply=replies.find(r=>r.id===request.id);
   if(!reply?.result?.length)continue;
   if(!delayedRound){delayedRound=topics[1];delayedUntil=Date.now()+delayDrawMs;}
   if(topics[1]===delayedRound&&Date.now()<delayedUntil){reply.result=[];withheldDrawReads++;}
  }
  await route.fulfill({response,json:Array.isArray(payload)?replies:replies[0]});
 });

 await page.addInitScript(()=>{

  window.loopProof={replays:[],frames:[],draws:[],presented:[],machinePhases:[],transitions:[],launchCameras:[],ascentCameras:[]};

  document.addEventListener('plank:flight-replay-start',e=>window.loopProof.replays.push(e.detail));
  document.addEventListener('plank:lottery-result',e=>window.loopProof.draws.push({...e.detail,receivedAt:performance.now()}));

  document.addEventListener('plank:lottery-presented',e=>window.loopProof.presented.push({...e.detail,presentedAt:performance.now()}));

  let lastPhase='';

  function frame(){

   const stage=document.querySelector('.stage'),machine=document.querySelector('.lottery-theatre[open] canvas');

   if(stage&&window.loopProof.frames.length<20000)window.loopProof.frames.push({phase:stage.dataset.presentation,altitude:Number(stage.dataset.altitude||0),status:document.querySelector('#substatus')?.textContent});

   if(machine&&machine.dataset.phase!==lastPhase){lastPhase=machine.dataset.phase;window.loopProof.machinePhases.push({phase:lastPhase,at:performance.now(),position:machine.dataset.ballPosition,physics:machine.dataset.physics});}
   const camera=window.__plankCamera;
   if(camera?.parked&&!window.loopProof.launchCameras.some(c=>c.afterDraws===window.loopProof.presented.length))window.loopProof.launchCameras.push({...camera,afterDraws:window.loopProof.presented.length});
   if(camera&&!camera.parked&&camera.clearance>0&&window.loopProof.ascentCameras.length<20000)window.loopProof.ascentCameras.push({...camera});

   requestAnimationFrame(frame);

  }requestAnimationFrame(frame);

 });

 await page.goto('http://127.0.0.1:8765/arcade/crash.html');

 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));

 await page.waitForTimeout(1800);
 assert.deepEqual(errors,[],'bootstrap must not interrupt the render loop');
 assert.ok((await page.locator('.stage').boundingBox()).height>300,'visible playfield must not collapse');

 assert.ok((await page.locator('#fx').boundingBox()).height>300,'visible canvas must not collapse');

 await page.screenshot({path:resolve(output,'mobile-ready.png')});

 const initialQuote=await page.locator('.pocket-stake-picker output').textContent();assert.match(initialQuote,/Ξ/);

 await page.locator('#simBtn').evaluate(b=>b.click());

 await page.waitForFunction(()=>/Play|Ready|Next round/.test(document.querySelector('#primaryBtn').textContent));

 if(process.env.PLANK_TARGET){await page.waitForFunction(()=>!document.querySelector('#autoTargetInput').disabled,null,{timeout:60000});await page.locator('#autoTargetInput').fill(process.env.PLANK_TARGET);await page.locator('#autoTargetInput').dispatchEvent('change');}
 const deadline=Date.now()+Number(process.env.PLANK_LOOP_MS||200000);let collected=false,flightShot=false,ballShot=false;

 while(Date.now()<deadline){

  const state=await page.evaluate(()=>({phase:document.querySelector('.stage')?.dataset.presentation,status:document.querySelector('#substatus')?.textContent,modal:!!document.querySelector('.lottery-theatre[open]'),presented:document.querySelector('.lottery-theatre')?.dataset.reveal==='presented',collect:!!document.querySelector('.lottery-collect:not([hidden])')}));

  if(state.phase==='flight'&&!flightShot&&await page.locator('.stage').evaluate(s=>Number(s.dataset.altitude)>.1)){await page.screenshot({path:resolve(output,'mobile-flight.png')});flightShot=true;}
  if(state.modal&&state.presented){

   if(!ballShot){await page.screenshot({path:resolve(output,'mobile-gumball.png')});ballShot=true;}

   if(state.collect){

    await page.locator('.lottery-collect').click();

    await page.waitForFunction(()=>document.querySelector('.lottery-theatre').dataset.collected==='true',{},{timeout:15000});

    collected=true;await page.screenshot({path:resolve(output,'mobile-collected.png')});

   }

   await page.locator('.lottery-next').click();

  }

  if(!state.modal)await page.locator('#primaryBtn').evaluate(button=>{if(!button.disabled&&/^Play(?: · \d+)?$/.test(button.textContent.trim()))button.click();});

  const complete=await page.evaluate(()=>window.loopProof.presented.filter(p=>!p.preview).length);

  if(complete>=3&&(collected||process.env.PLANK_REQUIRE_COLLECTION!=='1'))break;
  await page.waitForTimeout(160);

 }

 const proof=await page.evaluate(()=>window.loopProof);

 const draws=proof.draws.filter(d=>d.participated);

 assert.ok(draws.length>=3,`three complete played rounds required; got ${draws.length}`);

 if(process.env.PLANK_TARGET)for(const draw of draws){assert.equal(BigInt(draw.targetBps),BigInt(Math.round(Number(process.env.PLANK_TARGET)*10000)));assert.equal(await crash.targetOf(BigInt(draw.roundId),draw.player),BigInt(draw.targetBps));}
 assert.ok(draws.every(d=>d.verified===true));assert.ok(proof.presented.length>=3);
 for(const draw of draws){const presented=proof.presented.find(p=>p.roundId===draw.roundId);assert.ok(presented&&presented.presentedAt-draw.receivedAt>=1700,'crash finale must precede lottery presentation');}

 for(const phase of ['mixing','chute','rolling','orienting','presented'])assert.ok(proof.machinePhases.some(p=>p.phase===phase),`missing gumball phase ${phase}`);

 assert.ok(proof.frames.some(f=>f.phase==='flight'&&f.altitude>0),'no ascent');
 assert.ok(proof.frames.some(f=>f.phase==='crash'),'missing visible crash finale');
 assert.ok(proof.launchCameras.length>=2,'must observe launch framing across repeated rounds');
 const baseline=proof.launchCameras[0];
 for(const c of proof.launchCameras){assert.equal(c.fov,42);for(const key of ['x','y','z','padY','rocketY'])assert.ok(Math.abs(c[key]-baseline[key])<1e-9,`launch ${key} drifted`);}
 assert.ok(proof.ascentCameras.some(c=>c.clearance>2.2),'craft must clear the platform');
 assert.ok(proof.ascentCameras.every(c=>c.padVisible&&c.padY===baseline.padY),'tower must remain fixed and visible in world space');

 assert.ok(!proof.frames.some(f=>/Launch in (?:[4-9]\d|\d{3})s/.test(f.status||'')),'preview used the production oracle countdown');

 assert.deepEqual(errors,[]);
 if(delayDrawMs>0){
  assert.ok(withheldDrawReads>1,'delayed draw must require multiple retries');
  const rid=BigInt(delayedRound).toString(),status=`Round ${rid} replay`;
  let starts=0,wasReplay=false;
  for(const frame of proof.frames){const replay=frame.status===status;if(replay&&!wasReplay)starts++;wasReplay=replay;}
  assert.equal(proof.replays.filter(r=>r.roundId===rid).length,1,'delayed draw must not restart its flight');
  assert.equal(proof.draws.filter(d=>d.roundId===rid).length,1,'recovered draw presented exactly once');
 }

 if(process.env.PLANK_REQUIRE_COLLECTION==='1')assert.ok(collected,'a verified winning draw must be collected');

 await page.setViewportSize({width:1122,height:1402});

 await page.waitForTimeout(500);await page.screenshot({path:resolve(output,'desktop-current.png')});

 const summary={passed:true,withheldDrawReads,bettingSeconds:30,playedRounds:draws.map(d=>d.roundId),verifiedDraws:draws.length,lotteryCollected:collected,machinePhases:[...new Set(proof.machinePhases.map(p=>p.phase))],flightFrames:proof.frames.filter(f=>f.phase==='flight').length,errors,initialQuote};

 await writeFile(resolve(output,'loop-proof.json'),JSON.stringify({summary,draws,replays:proof.replays,presented:proof.presented,machinePhases:proof.machinePhases,launchCameras:proof.launchCameras,ascentSamples:proof.ascentCameras.filter((_,i)=>i%30===0)},null,2));

 console.log(JSON.stringify(summary));

}finally{for(const context of browser.contexts())for(const page of context.pages())await page.unrouteAll({behavior:"ignoreErrors"});await browser.close();}

