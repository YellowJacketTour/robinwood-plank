import {expect} from 'chai';
import {ethers,networkHelpers} from './helpers/hardhat.js';
import {deployCasino,settleCurrent} from './helpers/casino.js';
describe('Round-bound wagering',()=>{
 for(const scalable of [false,true])it(`rejects delayed direct and session wagers without consuming funds (${scalable?'indexed':'current'})`,async()=>{
  const e=await deployCasino(scalable?{scalable:{maxRoundStakeWei:10n**30n,maxUnderwritingWei:10n**30n}}:{});
  const id=await e.crash.currentRoundId(),amount=await e.crash.minStakeWei();
  const key=e.signers[10];await e.bank.connect(e.alice).deposit({value:amount*3n});
  await e.bank.connect(e.alice).grantSession(key.address,amount*3n,BigInt(await networkHelpers.time.latest())+3600n);
  await e.crash.connect(e.bob).placeBetInRound(id,20000n,{value:amount});
  await settleCurrent(e, ethers.keccak256(ethers.toUtf8Bytes("round-bound-test")));
  const next=await e.crash.currentRoundId();expect(next).to.equal(id+1n);
  await expect(e.crash.connect(e.alice).placeBetInRound(id,20000n,{value:amount})).to.be.revertedWithCustomError(e.crash,'WrongRound');
  await expect(e.bank.connect(key).betViaInRound(e.crashAddr,id,amount,20000n)).to.be.revertedWithCustomError(e.crash,'WrongRound');
  expect(await e.bank.balanceOf(e.alice.address)).to.equal(amount*3n);
  expect((await e.bank.sessions(key.address)).spent).to.equal(0n);
  expect(await e.crash.stakeOf(next,e.alice.address)).to.equal(0n);
  await e.bank.connect(key).betViaInRound(e.crashAddr,next,amount,20000n);
  expect(await e.crash.stakeOf(next,e.alice.address)).to.equal(amount);
 });
});
