import {expect} from 'chai';
import {ethers, networkHelpers} from './helpers/hardhat.js';
import {deployCasino,closeBetting,settleCurrent,findRandomness,freshAddress,assertConserved,winnerOf} from './helpers/casino.js';
import {settleCappedPool} from '../../lib/casino/economics-capped-pool.js';

describe('Indexed crash: bounded clearing and independent claims',()=>{
 const quantum=10000n;
 async function setup(bettingDurationSeconds=120n){return deployCasino({numberedLottery:true,scalable:{maxRoundStakeWei:10n**24n,maxUnderwritingWei:10n**16n},crash:{minStakeWei:quantum,maxSeats:1000000000n,emissionBufferCapWei:0n,bettingDurationSeconds}});}
 it('rejects non-quantized stakes and round exposure before accepting funds',async()=>{
  const e=await setup();
  await expect(e.crash.connect(e.alice).placeBet(20000n,{value:10001n})).revertedWithCustomError(e.crash,'BadQuantum');
  const small=await deployCasino({scalable:{maxRoundStakeWei:20000n,maxUnderwritingWei:0n},crash:{minStakeWei:quantum}});
  await small.crash.connect(small.alice).placeBet(20000n,{value:20000n});
  await expect(small.crash.connect(small.bob).placeBet(20000n,{value:quantum})).revertedWithCustomError(small.crash,'ExposureLimit');
  await assertConserved(small,expect);
 });
 it('keeps delayed claims and rounding dust segregated across later settlements and stalled commitments',async()=>{
  const e=await setup();const id=await e.crash.currentRoundId(),r=await e.crash.currentRound();
  await e.crash.connect(e.alice).placeBet(20000n,{value:70000n});
  await e.crash.connect(e.bob).placeBet(20000n,{value:110000n});
  await e.crash.connect(e.carol).placeBet(100000000n,{value:10000n});
  const random=await findRandomness(e,id,r.targetDrandRound,c=>c>=20000n&&c<100000000n);
  await settleCurrent(e,random);
  expect(await e.crash.claimEscrow(id)).eq(181450n);
  expect(await e.crash.paidOf(id,e.alice.address)).eq(70563n);
  expect(await e.crash.paidOf(id,e.bob.address)).eq(110886n);
  await e.crash.connect(e.keeper).claimPayout(id,e.alice.address);
  await e.crash.connect(e.alice).withdrawToBank(await e.bank.getAddress());
  const next=await e.crash.currentRoundId(),round=await e.crash.currentRound();
  await e.crash.connect(e.dave).placeBet(20000n,{value:10000n});
  await closeBetting(e);await e.crash.lockRound();
  await networkHelpers.time.increaseTo(round.revealNotBefore+e.crashConfig.refundTimeoutSeconds);
  await expect(e.crash.refundRound()).revertedWithCustomError(e.crash,'CommittedRoundCannotBeCancelled');
  await expect(e.crash.claimRefund(next,e.dave.address)).revertedWithCustomError(e.crash,'BadPhase');
  await settleCurrent(e,await findRandomness(e,next,round.targetDrandRound,c=>c<20000n));
  expect(await e.crash.claimEscrow(id)).eq(110887n);
  const before=await e.crash.buffer();
  await expect(e.crash.connect(e.carol).claimPayout(id,e.bob.address)).emit(e.crash,'ClaimDustReturned').withArgs(id,1n);
  expect(await e.crash.buffer()).eq(before+1n);
  expect(await e.crash.totalClaimEscrow()).eq(0n);
  await expect(e.crash.claimPayout(next,e.dave.address)).revertedWithCustomError(e.crash,'NoBet');
  await expect(e.crash.claimPayout(id,e.carol.address)).revertedWithCustomError(e.crash,'NoBet');
  await e.crash.connect(e.bob).withdraw();await expect(e.crash.connect(e.dave).withdraw()).revertedWithCustomError(e.crash,'NothingToWithdraw');
  await assertConserved(e,expect);
 });
 it('cannot seed protected principal or exceed the immutable underwriting cap',async()=>{
  const e=await setup();
  const id=await e.crash.currentRoundId(),r=await e.crash.currentRound();
  await e.crash.connect(e.alice).placeBet(100000000n,{value:ethers.parseEther('1')});
  await settleCurrent(e,await findRandomness(e,id,r.targetDrandRound,c=>c<100000000n));
  await e.crash.flushRake();await e.rakeRouter.claimVault();
  const protectedBefore=await e.crash.protectedPrincipal();
  expect(protectedBefore).greaterThan(0n);
  expect(await e.crash.nextSeed()).eq(10n**16n);
  await closeBetting(e);await e.crash.lockRound();
  expect((await e.crash.currentRound()).seed).eq(10n**16n);
  expect(await e.crash.protectedPrincipal()).eq(protectedBefore);
  await assertConserved(e,expect);
 });
 it('matches independent capped payouts and preserves old claims across rolling rounds',async()=>{
  const e=await setup();await e.crash.fundVault({value:10n**15n});
  await closeBetting(e);await e.crash.lockRound();
  for(let round=0;round<12;round++){
   const id=await e.crash.currentRoundId(),r=await e.crash.currentRound();
   const players=[e.alice,e.bob,e.carol,e.dave],targets=[10100n,20000n,50000n,100000n];
   const seats=players.map((p,i)=>({id:p.address,stake:quantum*BigInt((i+1)*(round+1)),targetBps:targets[(i+round)%4]}));
   for(let i=0;i<4;i++)await e.crash.connect(players[i]).placeBet(seats[i].targetBps,{value:seats[i].stake});
   const {crashBps,round:done,seed}=await settleCurrent(e,ethers.toBeHex(round+1,32));
   const expected=settleCappedPool(done.playerDistributable,r.seed,crashBps,seats);
   expect(done.lotteryWinner).eq(winnerOf(seats.map(s=>({player:s.id,stake:s.stake})),seed));
   for(const s of seats){
    const p=expected.allocations.find(x=>x.id===s.id)!;
    expect(await e.crash.paidOf(id,s.id)).eq(p.payout);
    if(p.survived){
     const before=await e.crash.owed(s.id);
     await e.crash.connect(e.keeper).claimPayout(id,s.id);
     expect(await e.crash.owed(s.id)).eq(before+p.payout);
     await expect(e.crash.claimPayout(id,s.id)).revertedWithCustomError(e.crash,'AlreadyClaimed');
    }
   }
   expect(await e.crash.claimEscrow(id)).eq(0n);
   await assertConserved(e,expect);
  }
  for(const p of [e.alice,e.bob,e.carol,e.dave])if(await e.crash.owed(p.address)>0n)await e.crash.connect(p).withdraw();
  await assertConserved(e,expect);
 });
 for(const n of [256,1024,4096])it(`settles ${n} actual on-chain positions without scanning them and claims independently`,async function(){
  this.timeout(180000);
  const e=await setup(100000n);
  await e.crash.fundVault({value:10n**16n});await closeBetting(e);await e.crash.lockRound();
  const id=await e.crash.currentRoundId(),r=await e.crash.currentRound();
  const bank=await e.bank.getAddress();await networkHelpers.impersonateAccount(bank);
  await networkHelpers.setBalance(bank,ethers.parseEther('10'));const signer=await ethers.getSigner(bank);
  // This fixture explicitly gives all individual mined transactions time to enter.
  // Production deadlines remain fixed and cannot be extended by entrants.
  const positions=[];let firstAdmissionGas=0n,lastAdmissionGas=0n;
  for(let i=0;i<n;i++){
   const player=freshAddress(),stake=1000000000000n,target=10100n+BigInt((i*997)%190000);
   const tx=await e.crash.connect(signer).placeBetFor(player,target,{value:stake});
   if(i===0||i===n-1){const rc=await tx.wait();if(i===0)firstAdmissionGas=rc.gasUsed;else lastAdmissionGas=rc.gasUsed;}
   positions.push({id:player,stake,targetBps:target});
  }
  expect(await e.crash.seatCount(id)).eq(BigInt(n));
  if(n>256)await expect(e.crash.seatsOf(id)).revertedWithCustomError(e.crash,'UsePagination');
  else expect((await e.crash.seatsOf(id)).length).eq(n);
  expect((await e.crash.seatsPage(id,n-24,256)).length).eq(24);
  const entropy=await findRandomness(e,id,r.targetDrandRound,c=>c>=210000n);
  const {receipt,round:done,seed}=await settleCurrent(e,entropy);
  expect(receipt.gasUsed).lessThan(4000000n);
  console.log(`indexed settlement ${n} positions gas: ${receipt.gasUsed}; first/last admission: ${firstAdmissionGas}/${lastAdmissionGas}`);
  expect(done.lotteryWinner).eq(winnerOf(positions.map(p=>({player:p.id,stake:p.stake})),seed));
  for(const i of [0,1,Math.floor(n/2)-1,n-1]){
   const p=positions[i],quoted=await e.crash.paidOf(id,p.id);
   expect(quoted).at.most(p.stake*p.targetBps/10000n);
   expect(quoted).at.least(p.stake*7500n/10000n);
   const tx=await e.crash.claimPayout(id,p.id),rc=await tx.wait();expect(rc.gasUsed).lessThan(200000n);
   expect(await e.crash.owed(p.id)).eq(quoted);
  }
  // Unclaimed old positions remain fully funded while the next round runs.
  expect(await e.crash.totalClaimEscrow()).greaterThan(0n);
  expect(await e.crash.currentRoundId()).eq(id+1n);
  await assertConserved(e,expect);
 });
});
