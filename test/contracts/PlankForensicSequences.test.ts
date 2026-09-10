import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,bet,settleCurrent,closeBetting,increaseToAtLeast,assertConserved} from './helpers/casino.js';
describe('Adversarial cross-contract recovery sequences',()=>{
 it('preserves real growing principal and all exits through 48 interleaved funded rounds, pauses, failures and retries',async function(){
  this.timeout(120000);
  const e=await deployCasino({guarded:true,cycleLottery:true,recoverableLottery:true,crash:{minStakeWei:10n**12n}});
  await e.crash.fundVault({value:10n**17n});await e.lottery.fund({value:10n**16n});
  const players=[e.alice,e.bob,e.carol,e.dave],targets=[10100n,11000n,20000n,50000n,1000000n];
  let state=193773n,principal=0n,recoveries=0,pauses=0,paidExits=0;
  const random=()=>{state=(state*1664525n+1013904223n)&0xffffffffn;return state;};
  for(let round=0;round<48;round++){
   const id=await e.crash.currentRoundId(),fail=round%7===2,pause=round%8===3;
   for(const player of players){const stake=10n**12n*(1n+random()%1000n);await e.crash.connect(player).placeBetInRound(id,targets[Number(random()%5n)],{value:stake});}
   if(pause){await e.crash.connect(e.keeper).freeze();pauses++;}
   if(fail)await e.lottery.setBroken(true);
   await settleCurrent(e,ethers.toBeHex(random(),32));
   if(fail){
    expect(await e.crash.currentRoundId()).eq(id);expect(await e.crash.pendingLotteryRound()).eq(id);
    await expect(e.crash.retryLottery()).revertedWith('lottery unavailable');
    const terms=await e.lottery.quote();await e.lottery.fund({value:1n+random()%100000n});expect(await e.lottery.quote()).deep.eq(terms);
   }
   // Exit before fixing the next-round dependency, never after a convenient reset.
   for(const player of players){
    if(await e.crash.owed(player.address)>0n){await e.crash.connect(player).withdrawTo(player.address);paidExits++;}
    if(await e.lottery.owed(player.address)>0n)await e.lottery.connect(player).withdrawTo(player.address);
   }
   if(fail){await e.lottery.setBroken(false);await e.crash.connect(e.dave).retryLottery();recoveries++;}
   await e.crash.flushRake();
   for(const [balance,claim] of [['vaultEscrow','claimVault'],['lotteryEscrow','claimLottery'],['burnEscrow','claimBurn'],['founderEscrow','claimFounders']])if(await e.rakeRouter[balance]()>0n)await e.rakeRouter[claim]();
   if(await e.lottery.founderEscrow()>0n)await e.lottery.withdrawFounderFees();
   const next=await e.crash.protectedPrincipal();expect(next,'actually route and grow principal, not a vacuous zero check').greaterThan(principal);principal=next;
   expect(await e.crash.reserve()).at.least(principal);expect(await e.crash.pendingLotteryRound()).eq(0n);await assertConserved(e,expect);
   if(pause){
    await expect(e.crash.connect(e.alice).placeBet(10100n,{value:10n**12n})).revertedWithCustomError(e.crash,'AdmissionsPaused');
    await e.crash.connect(e.treasury).requestReopen();await increaseToAtLeast(await e.crash.reopenAt());await e.crash.connect(e.bob).executeReopen();
    // Reopening never extends the existing book's expired acceptance deadline.
    await expect(e.crash.connect(e.alice).placeBet(10100n,{value:10n**12n})).revertedWithCustomError(e.crash,'TooLate');
    await e.crash.lockRound();await assertConserved(e,expect);
   }
  }
  expect(recoveries).eq(7);expect(pauses).eq(6);expect(paidExits).greaterThan(0);expect(principal).greaterThan(0n);
  console.log(JSON.stringify({rounds:48,recoveries,pauses,paidExits,protectedPrincipal:principal.toString()}));
 });
});

