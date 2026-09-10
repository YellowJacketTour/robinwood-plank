import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,bet,closeBetting,increaseToAtLeast,assertConserved} from './helpers/casino.js';

describe('Local presentation schedule',()=>{
 it('preserves the 30-second result-to-liftoff interval through repeated real settlements',async()=>{
  const e=await deployCasino({guarded:true,timedPractice:true,numberedLottery:true,crash:{bettingDurationSeconds:30n,minParticipants:1n,minPoolWei:1n,maxStakePerWalletBps:10000n}});
  for(let n=1;n<=5;n++){
   const id=await e.crash.currentRoundId();const lift=await e.crash.practiceLiftoffAtMs(id);
   await bet(e,e.alice,'0.01',20000n);await closeBetting(e);await e.crash.lockRound();
   const r=await e.crash.rounds(id);await e.beacon.setRandomness(r.targetDrandRound,ethers.toBeHex(n,32));await e.crash.settleRound();
   const settled=await e.crash.rounds(id),next=await e.crash.currentRoundId();expect(next).eq(id+1n);
   const nextLift=await e.crash.practiceLiftoffAtMs(next),nextRound=await e.crash.rounds(next);
   const expected=Number(lift)+Math.log(Number(settled.crashBps)/10000)/.22*1000+2600+4800+30000;
   expect(Math.abs(Number(nextLift)-expected)).lessThan(2);
   expect(Number(nextLift-nextRound.bettingEndsAt*1000n)).within(8000,8999);
   await assertConserved(e,expect);
  }
 });
 it('rebases a delayed settlement into a usable future betting window',async()=>{
  const e=await deployCasino({guarded:true,timedPractice:true,crash:{bettingDurationSeconds:30n,minParticipants:1n,minPoolWei:1n,maxStakePerWalletBps:10000n}});
  await bet(e,e.alice,'0.01',20000n);await closeBetting(e);await e.crash.lockRound();
  const r=await e.crash.currentRound();await increaseToAtLeast(r.bettingEndsAt+600n);
  await e.beacon.setRandomness(r.targetDrandRound,ethers.toBeHex(123,32));await e.crash.settleRound();
  const next=await e.crash.currentRound(),now=BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
  expect(next.bettingEndsAt-now).gte(29n);await assertConserved(e,expect);
 });
});
