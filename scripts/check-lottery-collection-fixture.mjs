// Explicit deterministic local fixture. Never changes the normal preview manifest or keeper.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {JsonRpcProvider,Contract,AbiCoder,id,toBeHex,keccak256} from 'ethers';
import assert from 'node:assert/strict';
const [manifestPath,outPath]=process.argv.slice(2);assert.ok(manifestPath&&outPath);
const output=resolve(outPath);await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const rpc=new JsonRpcProvider('http://127.0.0.1:8545',undefined,{cacheTimeout:-1});assert.equal((await rpc.getNetwork()).chainId,31337n);
const keeper=await rpc.getSigner(6),player=await rpc.getSigner(0);
const abi=async name=>JSON.parse(await readFile(`public/arcade/abi/${name}.json`,'utf8'));
const crash=new Contract(manifest.crash,await abi('PlankCrash'),keeper);
const lottery=new Contract(manifest.lottery,await abi('PlankNumberedLottery'),keeper);
const beacon=new Contract(manifest.beacon,['function setRandomness(uint64,bytes32)'],keeper);
let round=await crash.currentRound();
// Resume a previously interrupted run on this explicitly isolated mock stack.
if(Number(round.phase)===1){await(await beacon.setRandomness(round.targetDrandRound,toBeHex(1,32))).wait();await(await crash.settleRound()).wait();round=await crash.currentRound();}
if(Number(round.phase)===0&&Number(round.bettingEndsAt)<Date.now()/1000&&await crash.seatCount(await crash.currentRoundId())===0n)await(await crash.lockRound()).wait();
// A funded lottery commits its first prize when its first nonempty book settles.
if(await lottery.committedPrize()===0n){
 const warmId=await crash.currentRoundId();
 if(await crash.seatCount(warmId)===0n)await(await crash.placeBetInRound(warmId,20000n,{value:await crash.minStakeWei()})).wait();
 const warm=await crash.rounds(warmId);
 while((await rpc.getBlock('latest')).timestamp<Number(warm.bettingEndsAt))await new Promise(resolve=>setTimeout(resolve,300));
 if(Number((await crash.rounds(warmId)).phase)===0)await(await crash.lockRound()).wait();
 await(await beacon.setRandomness(warm.targetDrandRound,toBeHex(1,32))).wait();
 try{await(await crash.settleRound()).wait();}catch(error){if(Number((await crash.rounds(warmId)).phase)!==2)throw error;}
}
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/deploy-addresses.local.json',route=>route.fulfill({json:manifest}));
 await page.addInitScript(()=>{
  window.fixtureDraws=[];document.addEventListener('plank:lottery-result',e=>window.fixtureDraws.push(e.detail));
  document.addEventListener('DOMContentLoaded',()=>{const label=document.createElement('div');label.textContent='SCRIPTED WIN TEST · test ETH only';label.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;text-align:center;background:#542461;color:white;font:12px sans-serif;padding:5px';document.body.append(label);});
 });
 await page.goto('http://127.0.0.1:8765/arcade/crash.html');
 await page.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('hide'));
 await page.locator('#simBtn').evaluate(b=>b.click());
 // This isolated fixture has no background keeper. Browser startup may outlast
 // its empty admission window; advance only that empty round before playing.
 const admission=await crash.currentRound();
 if(Number(admission.phase)===0&&(await rpc.getBlock('latest')).timestamp>=Number(admission.bettingEndsAt)&&await crash.seatCount(await crash.currentRoundId())===0n)await(await crash.lockRound()).wait();
 await page.waitForFunction(()=>document.querySelector('#primaryBtn')?.textContent==='Play');
 await page.locator('#primaryBtn').click();
 const rid=await crash.currentRoundId();
 for(let tries=0;tries<50&&await crash.stakeOf(rid,player.address)===0n;tries++)await page.waitForTimeout(200);
 assert.ok(await crash.stakeOf(rid,player.address)>0n);
 round=await crash.rounds(rid);
 const rake=await crash.effectiveRakeBps(),gross=round.playerPool-round.playerPool*(10000n-rake)/10000n;
 const net=gross-gross*(await crash.keeperRewardBps())/10000n;
 const count=await lottery.ballCountFor(net,await lottery.committedPrize());assert.ok(count>0n);
 let randomness,crashBps;
 const coder=AbiCoder.defaultAbiCoder();
 for(let candidate=1n;candidate<=100000n;candidate++){
  const random=toBeHex(candidate,32);
  // Verify the contract domain rather than assuming a candidate from a different release.
  const actualSeed=await crash.resultSeed(rid,round.targetDrandRound,random);
  const residue=BigInt(actualSeed)%10000n,bps=100000000n/(10000n-residue);
  const raw=BigInt(keccak256(coder.encode(['bytes32','bytes32'],[id('PLANK_NUMBERED_BALL_V1'),actualSeed])));
  if(count-raw%count===1n&&bps>=50000n&&bps<=100000n){randomness=random;crashBps=bps;break;}
 }
 assert.ok(randomness,'bounded scripted winning sample');
 while((await rpc.getBlock('latest')).timestamp<Number(round.bettingEndsAt))await page.waitForTimeout(300);
 if(Number((await crash.rounds(rid)).phase)===0){try{await(await crash.lockRound()).wait();}catch(error){if(Number((await crash.rounds(rid)).phase)===0)throw error;}}
 await(await beacon.setRandomness(round.targetDrandRound,randomness)).wait();
 try{await(await crash.settleRound()).wait();}catch(error){if(Number((await crash.rounds(rid)).phase)!==2)throw error;}
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre')?.dataset.reveal==='presented'&&!document.querySelector('.lottery-collect')?.hidden,null,{timeout:60000});
 const owedBefore=await lottery.owed(player.address);assert.ok(owedBefore>0n);
 await page.screenshot({path:resolve(output,'scripted-prize.png')});
 await page.locator('.lottery-collect').click();
 await page.waitForFunction(()=>document.querySelector('.lottery-theatre')?.dataset.collected==='true',null,{timeout:20000});
 assert.equal(await lottery.owed(player.address),0n);assert.deepEqual(errors,[]);
 const draws=await page.evaluate(()=>window.fixtureDraws);
 assert.ok(draws.some(d=>d.verified&&d.hit&&d.isWinner&&d.drawnBall==='1'));
 await page.screenshot({path:resolve(output,'scripted-collected.png')});
 const proof={passed:true,scope:'Scripted winning entropy on an isolated local deployment; NOT natural outcome frequency or mainnet evidence',chainId:31337,crash:manifest.crash,lottery:manifest.lottery,round:String(rid),crashBps:String(crashBps),owedBefore:String(owedBefore),owedAfter:'0',draws,errors};
 await writeFile(resolve(output,'collection-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await browser.close();}
