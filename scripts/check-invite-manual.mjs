import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out=process.env.PLANK_INVITE_OUTPUT;await mkdir(out,{recursive:true});
const token=(await readFile(process.env.PLANK_INVITE_TOKEN_FILE,'utf8')).trim();
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
const errors=[];
try{
 const pages=[];
 for(let i=0;i<2;i++){
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});pages.push(page);
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.manualProof={draws:[],presented:[],bets:0};document.addEventListener('plank:bet-confirmed',()=>window.manualProof.bets++);document.addEventListener('plank:lottery-result',e=>window.manualProof.draws.push(e.detail));document.addEventListener('plank:lottery-presented',e=>window.manualProof.presented.push(e.detail));});
  await page.goto(`${process.env.PLANK_INVITE_URL}/#invite=${token}`);
  await page.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
  assert.equal(await page.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
 }
 const [player,spectator]=pages;
 const state=page=>page.evaluate(async()=>{
  const m=await(await fetch('/arcade/deploy-addresses.local.json')).json();const p=new ethers.JsonRpcProvider(location.origin+'/api/invite/rpc');
  try{const c=new ethers.Contract(m.crash,['function currentRoundId() view returns(uint256)','function stakeOf(uint256,address) view returns(uint256)','function targetOf(uint256,address) view returns(uint32)'],p);const round=await c.currentRoundId(),address=document.querySelector('.invite-player output').dataset.address,b=await p.getBlock('latest');return {round:String(round),stake:String(await c.stakeOf(round,address)),target:String(await c.targetOf(round,address)),block:b.number,time:b.timestamp};}finally{p.destroy();}
 });
 const initial=await state(spectator);assert.equal(initial.stake,'0');
 assert.equal(await player.getByRole('button',{name:'Lower stake'}).isDisabled(),true);
 await player.locator('#autoTargetInput').fill('0');
 await player.waitForTimeout(100);assert.equal(await player.locator('#primaryBtn').isDisabled(),true);
 await player.locator('#autoTargetInput').fill('3.25');
 await player.getByRole('button',{name:'Higher stake'}).tap();
 await player.waitForFunction(()=>!document.querySelector('#primaryBtn').disabled,null,{timeout:65000});
 if(await player.locator('.lottery-theatre[open]').count())await player.locator('.lottery-close').tap();
 await player.locator('#primaryBtn').tap();
 await player.waitForFunction(()=>window.manualProof.bets===1,null,{timeout:30000});
 const accepted=await state(player);assert.equal(accepted.target,'32500');assert.equal(accepted.stake,'10000000000000');
 await player.locator('#autoTargetInput').fill('4.50');
 assert.equal(await player.locator('#autoTargetInput').isDisabled(),false);
 const unchanged=await state(player);assert.equal(unchanged.target,'32500');
 // Pause/rearm cannot cancel or duplicate a commitment already accepted.
 await player.locator('.invite-repeat').tap();await player.locator('.invite-repeat').tap();
 await player.waitForTimeout(300);assert.equal(await player.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
 assert.equal((await state(player)).stake,accepted.stake);assert.equal(await player.evaluate(()=>window.manualProof.bets),1);
 const deadline=Date.now()+120000;
 while(Date.now()<deadline){
  const both=await Promise.all(pages.map(p=>p.evaluate(round=>window.manualProof.presented.some(d=>d.roundId===round),accepted.round)));
  if(both.every(Boolean))break;
  await player.waitForTimeout(300);
 }
 const proofs=await Promise.all(pages.map(p=>p.evaluate(()=>window.manualProof)));
 for(const p of proofs)assert.ok(p.presented.some(d=>d.roundId===accepted.round),'Both bettor and spectator see the lottery');
 const a=proofs[0].draws.find(d=>d.roundId===accepted.round),b=proofs[1].draws.find(d=>d.roundId===accepted.round);
 assert.equal(a.drawnBall,b.drawnBall);assert.equal(a.ballCount,b.ballCount);assert.equal(b.participated,false);assert.equal(proofs[1].bets,0);
 await player.waitForFunction(()=>window.__plankCamera?.parked===true,null,{timeout:10000});
 const prepared=await player.evaluate(()=>window.__plankCamera);
 assert.ok(Math.abs(prepared.clearance)<1e-6);assert.equal(prepared.fov,42);assert.equal(prepared.padVisible,true);
 const later=await state(spectator);assert.ok(BigInt(later.round)>BigInt(initial.round));assert.ok(later.time>initial.time);
 await spectator.reload();await spectator.waitForFunction(()=>document.querySelector('.invite-player output')?.dataset.address,null,{timeout:60000});
 assert.equal(await spectator.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
 // Opt-in repeat pauses as soon as the player starts editing a target.
 await spectator.locator('.invite-repeat').tap();await spectator.locator('#autoTargetInput').fill('2.75');
 assert.equal(await spectator.locator('.invite-repeat').getAttribute('aria-pressed'),'false');
 assert.deepEqual(errors,[]);await writeFile(`${out}/proof.json`,JSON.stringify({passed:true,initial,accepted,unchanged,later,proofs,errors},null,2));
 console.log(JSON.stringify({passed:true,manualTarget:accepted.target,manualStake:accepted.stake,sharedRound:accepted.round,spectatorBets:proofs[1].bets,clockAdvanced:true,errors}));
}finally{await browser.close();}
