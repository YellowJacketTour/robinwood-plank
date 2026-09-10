import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,closeBetting,increaseToAtLeast,findRandomness,settleCurrent} from './helpers/casino.js';
// Regression for selective relay: public losses cannot be cancelled, refunded,
// rerolled or skipped. Mock entropy models publication, not signature forgery.
describe('Relay-absence economic option — cancellation regression',()=>{
 it('rejects the former selective loss refund and later settles the original loss',async()=>{
  const e=await deployCasino({guarded:true,cycleLottery:true,crash:{minStakeWei:10n**12n,refundTimeoutSeconds:60n}});
  await e.crash.fundVault({value:10n**17n});await closeBetting(e);await e.crash.lockRound();
  const stake=10n**15n;
  let id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  await e.crash.connect(e.alice).placeBetInRound(id,20000n,{value:stake});
  await settleCurrent(e,await findRandomness(e,id,r.targetDrandRound,c=>c>=20000n));
  const winningCredit=await e.crash.owed(e.alice.address);expect(winningCredit).eq(stake*2n);
  await e.crash.connect(e.alice).withdraw();
  id=await e.crash.currentRoundId();r=await e.crash.rounds(id);
  await e.crash.connect(e.alice).placeBetInRound(id,20000n,{value:stake});
  const publishedLoss=await findRandomness(e,id,r.targetDrandRound,c=>c<20000n);
  const seed=await e.crash.resultSeed(id,r.targetDrandRound,publishedLoss);expect(await e.crash._deriveCrash(seed)).lessThan(20000n);
  // The actor knows the external outcome but does not relay it to this chain.
  await closeBetting(e);await e.crash.lockRound();await increaseToAtLeast(r.revealNotBefore+60n);
  for (const multiplier of [1n,30n,300n]) {
    await increaseToAtLeast(r.revealNotBefore+60n*multiplier);
    for (const actor of [e.alice,e.bob,e.keeper,e.treasury]) {
      await expect(e.crash.connect(actor).refundRound()).revertedWithCustomError(e.crash,'CommittedRoundCannotBeCancelled');
    }
    await expect(e.crash.claimRefund(id,e.alice.address)).revertedWithCustomError(e.crash,'BadPhase');
    await expect(e.crash.restartRounds()).revertedWithCustomError(e.crash,'BadPhase');
    expect(await e.crash.currentRoundId()).eq(id);
    expect((await e.crash.rounds(id)).targetDrandRound).eq(r.targetDrandRound);
    expect(await e.crash.owed(e.alice.address)).eq(0n);
  }
  await e.crash.freezeStalledRound();
  expect(await e.crash.admissionsPaused()).eq(true);
  await expect(e.crash.connect(e.treasury).requestReopen()).revertedWithCustomError(e.crash,'InvalidSafetyState');
  await expect(e.crash.connect(e.alice).placeBet(20000n,{value:stake})).revertedWithCustomError(e.crash,'AdmissionsPaused');
  await e.beacon.setRandomness(r.targetDrandRound,publishedLoss);
  await e.crash.connect(e.bob).settleRound();
  expect((await e.crash.rounds(id)).crashBps).lessThan(20000n);
  expect(await e.crash.owed(e.alice.address)).eq(0n);
  expect(await e.crash.unclaimedRefunds()).eq(0n);
  expect(winningCredit-stake*2n).eq(0n); // previous +stake option is gone
  await e.crash.connect(e.treasury).requestReopen();
  await increaseToAtLeast(await e.crash.reopenAt());await e.crash.executeReopen();
  expect(await e.crash.admissionsPaused()).eq(false);
 });
});
