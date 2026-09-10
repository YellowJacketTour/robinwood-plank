import {expect} from 'chai';
import {tick} from '../../scripts/casino-keeper.js';
import {ethers,networkHelpers} from './helpers/hardhat.js';
import {deployCasino,bet,closeBetting,settleCurrent,increaseToAtLeast,assertConserved,DRAND_GENESIS,DRAND_PERIOD,findRandomness} from './helpers/casino.js';

describe('Safety controls and dependency-independent exits',()=>{
 it('freezes every admission path but cannot debit players or cancel existing bets',async()=>{
  const e=await deployCasino({guarded:true,cycleLottery:true});
  await bet(e,e.alice,'0.001',10100n);
  await e.bank.connect(e.bob).deposit({value:ethers.parseEther('0.01')});
  const key=e.dave;const now=BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
  await e.bank.connect(e.bob).grantSession(key.address,ethers.parseEther('0.01'),now+86400n);
  await expect(e.crash.connect(e.alice).freeze()).revertedWithCustomError(e.crash,'UnauthorizedSafetyRole');
  await e.crash.connect(e.keeper).freeze();
  for(const call of [()=>e.crash.connect(e.bob).placeBet(20000n,{value:10n**12n}),()=>e.crash.connect(e.bob).placeBetInRound(1,20000n,{value:10n**12n}),()=>e.bank.connect(e.bob).bet(e.crashAddr,10n**12n,20000n),()=>e.bank.connect(key).betViaInRound(e.crashAddr,1,10n**12n,20000n)])await expect(call()).revertedWithCustomError(e.crash,'AdmissionsPaused');
  expect(await e.bank.balanceOf(e.bob.address)).eq(ethers.parseEther('0.01'));
  expect((await e.bank.sessions(key.address)).spent).eq(0n);
  await expect(e.crash.connect(e.keeper).withdraw()).revertedWithCustomError(e.crash,'NothingToWithdraw');
  await expect(e.crash.connect(e.keeper).refundRound()).revertedWithCustomError(e.crash,'BadPhase');
  await settleCurrent(e,ethers.toBeHex(123,32));
  expect((await e.crash.rounds(1)).phase).eq(2n);
  await e.bank.connect(e.bob).withdrawAll();expect(await e.bank.balanceOf(e.bob.address)).eq(0n);
  await assertConserved(e,expect);
 });
 it('only governance requests delayed reopening; guardian can veto; anyone executes after the delay',async()=>{
  const e=await deployCasino({guarded:true});
  await e.crash.connect(e.keeper).freeze();
  await expect(e.crash.connect(e.keeper).requestReopen()).revertedWithCustomError(e.crash,'UnauthorizedSafetyRole');
  await e.crash.connect(e.treasury).requestReopen();
  await expect(e.crash.executeReopen()).revertedWithCustomError(e.crash,'InvalidSafetyState');
  await e.crash.connect(e.keeper).freeze();expect(await e.crash.reopenAt()).eq(0n);
  await e.crash.connect(e.treasury).requestReopen();await increaseToAtLeast(await e.crash.reopenAt());
  const actions=await tick(ethers.provider,e.alice,{crash:e.crashAddr,lottery:await e.lottery.getAddress(),beacon:await e.beacon.getAddress(),router:await e.rakeRouter.getAddress()});
  expect(actions.some(a=>a.step==="executeReopen")).eq(true);expect(await e.crash.admissionsPaused()).eq(false);
  expect((await ethers.provider.getCode(e.crashAddr)).length/2-1).lessThan(24576);
 });
 it('a dead beacon freezes commitments while unrelated bank balances remain withdrawable',async()=>{
  const beacon=await(await ethers.getContractFactory('FailureBeacon')).deploy(DRAND_PERIOD,DRAND_GENESIS);
  const e=await deployCasino({guarded:true,beaconInstance:beacon,crash:{refundTimeoutSeconds:60n}});
  await bet(e,e.alice,'0.001',20000n);await closeBetting(e);await e.crash.lockRound();
  const id=await e.crash.currentRoundId(),round=await e.crash.rounds(id);
  await e.bank.connect(e.bob).deposit({value:10n**15n});
  await beacon.setBroken(true,true);await e.crash.connect(e.keeper).freeze();
  await increaseToAtLeast(round.revealNotBefore+60n*30n);
  const actions=await tick(ethers.provider,e.keeper,{crash:e.crashAddr,lottery:await e.lottery.getAddress(),beacon:await beacon.getAddress(),router:await e.rakeRouter.getAddress()});
  expect(actions.some(a=>a.step==='freezeStalledRound')).eq(true);
  expect(await e.crash.currentRoundId()).eq(id);expect((await e.crash.rounds(id)).phase).eq(1n);
  await expect(e.crash.claimRefund(id,e.alice.address)).revertedWithCustomError(e.crash,'BadPhase');
  await e.bank.connect(e.bob).withdrawAll();expect(await e.bank.balanceOf(e.bob.address)).eq(0n);
  await assertConserved(e,expect);
  await expect(e.crash.startRoundIsolated()).revertedWithCustomError(e.crash,'OnlySelf');
  await expect(e.crash.restartRounds()).revertedWithCustomError(e.crash,'BadPhase');
  await beacon.setBroken(false,false);await beacon.setRandomness(round.targetDrandRound,ethers.toBeHex(123,32));
  await e.crash.settleRound();expect(await e.crash.currentRoundId()).eq(id+1n);
 });
 it('settled credits survive next-round scheduling failure and cannot be refunded twice',async()=>{
  const beacon=await(await ethers.getContractFactory('FailureBeacon')).deploy(DRAND_PERIOD,DRAND_GENESIS);
  const e=await deployCasino({guarded:true,cycleLottery:true,beaconInstance:beacon});
  await bet(e,e.alice,'0.001',10100n);await closeBetting(e);await e.crash.lockRound();
  const r=await e.crash.rounds(1);await beacon.setRandomness(r.targetDrandRound,ethers.toBeHex(123,32));await beacon.setBroken(true,false);
  await expect(e.crash.settleRound()).emit(e.crash,'RoundStartDeferred');
  expect((await e.crash.rounds(1)).phase).eq(2n);
  await expect(e.crash.refundRound()).revertedWithCustomError(e.crash,'BadPhase');
  await expect(e.crash.settleRound()).revertedWithCustomError(e.crash,'BadPhase');
  await assertConserved(e,expect);
 });
 it('a nonpayable smart wallet can recover bank deposits to its chosen recipient; session keys cannot',async()=>{
  const e=await deployCasino();const actor=await(await ethers.getContractFactory('ExitReceiver')).deploy();
  const amount=10n**15n,bank=await e.bank.getAddress();
  await actor.execute(bank,e.bank.interface.encodeFunctionData('deposit'),{value:amount});
  await expect(actor.execute(bank,e.bank.interface.encodeFunctionData('withdrawAll'))).revertedWith('ETH send failed');
  expect(await e.bank.balanceOf(await actor.getAddress())).eq(amount);
  await expect(e.bank.connect(e.dave).withdrawTo(e.dave.address,amount)).revertedWithCustomError(e.bank,'InsufficientBalance');
  await actor.execute(bank,e.bank.interface.encodeFunctionData('withdrawTo',[e.bob.address,amount]));
  expect(await e.bank.balanceOf(await actor.getAddress())).eq(0n);
 });
 it('a failed lottery draw retries its original commitment exactly once before any new book opens',async()=>{
  const e=await deployCasino({guarded:true,cycleLottery:true,recoverableLottery:true});
  await e.lottery.fund({value:10n**15n});
  await bet(e,e.alice,'0.1',10100n);await settleCurrent(e,ethers.toBeHex(123,32));
  const id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  const quote=await e.lottery.quote();
  await bet(e,e.alice,'0.1',10100n);
  const netRake=10n**17n*450n/10000n;
  const count=await e.lottery.ballCountFor(netRake,quote[0]);
  const domain=await e.lottery.NUMBERED_BALL_DOMAIN();
  const randomness=await findRandomness(e,id,r.targetDrandRound,(crash,seed)=>crash>=10100n&&BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32'],[domain,seed])))%count===count-1n);
  await e.lottery.setBroken(true);
  const settled=await settleCurrent(e,randomness);
  expect(await e.crash.pendingLotteryRound()).eq(id);expect(await e.crash.currentRoundId()).eq(id);
  await expect(e.crash.restartRounds()).revertedWithCustomError(e.crash,'LotteryRecoveryPending');
  await expect(e.crash.connect(e.bob).placeBet(10100n,{value:10n**12n})).revertedWithCustomError(e.crash,'BadPhase');
  await expect(e.crash.retryLottery()).revertedWith('lottery unavailable');
  await e.crash.connect(e.alice).withdrawTo(e.bob.address);
  // New funding cannot reprice an already owed draw while its delivery is down.
  await e.lottery.fund({value:10n**16n});expect(await e.lottery.quote()).deep.eq(quote);
  await e.lottery.setBroken(false);
  await e.crash.connect(e.keeper).freeze();
  const actions=await tick(ethers.provider,e.bob,{crash:e.crashAddr,lottery:await e.lottery.getAddress(),beacon:await e.beacon.getAddress(),router:await e.rakeRouter.getAddress()});
  expect(actions.some(a=>a.step==='retryLottery')).eq(true);
  expect(await e.lottery.recordedSeed()).eq(settled.seed);expect(await e.lottery.recordedWinner()).eq(e.alice.address);
  expect(await e.lottery.recordedRake()).eq(netRake);expect(await e.lottery.lastRecordedRound()).eq(id);
  expect(await e.lottery.owed(e.alice.address)).eq(quote[1]);
  await e.lottery.connect(e.alice).withdrawTo(e.bob.address);expect(await e.lottery.owed(e.alice.address)).eq(0n);
  expect(await e.crash.pendingLotteryRound()).eq(0n);expect(await e.crash.currentRoundId()).eq(id+1n);
  await expect(e.crash.retryLottery()).revertedWithCustomError(e.crash,'BadPhase');
  await assertConserved(e,expect);
 });

 it('a timeout freeze cancels pending reopening and permits reopening only after original settlement',async()=>{
  const e=await deployCasino({guarded:true,crash:{refundTimeoutSeconds:60n}});
  await bet(e,e.alice,'0.001',20000n);const id=await e.crash.currentRoundId(),r=await e.crash.rounds(id);
  await e.crash.connect(e.keeper).freeze();await e.crash.connect(e.treasury).requestReopen();
  expect(await e.crash.reopenAt()).greaterThan(0n);
  await closeBetting(e);await e.crash.lockRound();await increaseToAtLeast(r.revealNotBefore+60n);
  await expect(e.crash.connect(e.bob).freezeStalledRound()).emit(e.crash,'RecoveryFreeze').withArgs(id);
  expect(await e.crash.reopenAt()).eq(0n);expect(await e.crash.admissionsPaused()).eq(true);
  await expect(e.crash.connect(e.treasury).requestReopen()).revertedWithCustomError(e.crash,'InvalidSafetyState');
  await expect(e.crash.freezeStalledRound()).revertedWithCustomError(e.crash,'RoundAlreadyStalled');
  const original=await findRandomness(e,id,r.targetDrandRound,c=>c>=20000n);
  await e.beacon.setRandomness(r.targetDrandRound,original);await e.crash.settleRound();
  await e.crash.connect(e.alice).withdrawTo(e.alice.address);
  await e.crash.connect(e.treasury).requestReopen();
  expect(await e.crash.owed(e.alice.address)).eq(0n);await assertConserved(e,expect);
 });

});
