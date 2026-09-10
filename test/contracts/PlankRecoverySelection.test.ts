import {expect} from 'chai';
import {tick} from '../../scripts/casino-keeper.js';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,bet,closeBetting,increaseToAtLeast,assertConserved,DRAND_PERIOD,DRAND_GENESIS} from './helpers/casino.js';

describe('Recovery must not cancel a verified outcome',()=>{
 it('a keeper returning after the long deadline still relays and settles the original round',async()=>{
  const e=await deployCasino({guarded:true,crash:{refundTimeoutSeconds:60n}});
  await bet(e,e.alice,'0.001',20000n);await closeBetting(e);await e.crash.lockRound();
  const id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  await increaseToAtLeast(r.revealNotBefore+60n*30n);
  const actions=await tick(ethers.provider,e.keeper,{crash:e.crashAddr,lottery:await e.lottery.getAddress(),beacon:await e.beacon.getAddress(),router:await e.rakeRouter.getAddress(),mockBeacon:true});
  expect(actions.some(a=>a.step==='mockBeacon.setRandomness')).eq(true);
  expect(actions.some(a=>a.step==='refundRound')).eq(false);
  expect((await e.crash.rounds(id)).phase).eq(2n);
  expect(await e.crash.admissionsPaused()).eq(false);
  await assertConserved(e,expect);
 });
 it('rejects known-entropy refunds beyond the abandoned deadline at every supplied gas budget',async()=>{
  const e=await deployCasino({guarded:true,crash:{refundTimeoutSeconds:60n}});
  await bet(e,e.alice,'0.001',20000n);await closeBetting(e);await e.crash.lockRound();
  const id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  await e.beacon.setRandomness(r.targetDrandRound,ethers.toBeHex(123,32));
  await increaseToAtLeast(r.revealNotBefore+60n*30n);
  for(const gasLimit of [80000,150000,300000,1000000]){
   await expect(e.crash.connect(e.alice).refundRound({gasLimit})).to.revert(ethers);
   expect((await e.crash.rounds(id)).phase).eq(1n);
   expect(await e.crash.unclaimedRefunds()).eq(0n);
  }
  await expect(e.crash.refundRound({gasLimit:1000000})).revertedWithCustomError(e.crash,'CommittedRoundCannotBeCancelled');
  await e.crash.settleRound();expect((await e.crash.rounds(id)).phase).eq(2n);
  await assertConserved(e,expect);
 });
 it('keeps a broken beacon commitment intact until its original result can be recovered',async()=>{
  const beacon=await(await ethers.getContractFactory('FailureBeacon')).deploy(DRAND_PERIOD,DRAND_GENESIS);
  const e=await deployCasino({guarded:true,beaconInstance:beacon,crash:{refundTimeoutSeconds:60n}});
  await bet(e,e.alice,'0.001',20000n);await closeBetting(e);await e.crash.lockRound();
  const id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  await beacon.setBroken(false,true);await increaseToAtLeast(r.revealNotBefore+60n);
  await expect(e.crash.refundRound()).revertedWithCustomError(e.crash,'CommittedRoundCannotBeCancelled');
  await increaseToAtLeast(r.revealNotBefore+60n*30n);
  await e.crash.freezeStalledRound();expect((await e.crash.rounds(id)).phase).eq(1n);
  expect(await e.crash.admissionsPaused()).eq(true);
  await expect(e.crash.claimRefund(id,e.alice.address)).revertedWithCustomError(e.crash,'BadPhase');
  await beacon.setBroken(false,false);await beacon.setRandomness(r.targetDrandRound,ethers.toBeHex(123,32));
  await e.crash.settleRound();expect((await e.crash.rounds(id)).phase).eq(2n);
  await assertConserved(e,expect);
 });
});
