import {expect} from 'chai';
import {deployCasino,closeBetting,CREDIT} from './helpers/casino.js';

describe('Capped-pool admission regression checks',()=>{
  async function setup(minPoolWei=2n*CREDIT){return deployCasino({crash:{minStakeWei:CREDIT,minPoolWei,maxSeats:4n,minParticipants:2n,maxStakePerWalletBps:6000n}});}
  it('two wallets remain valid without any identity-diversity assumption',async()=>{
    const e=await setup();const id=await e.crash.currentRoundId();
    await e.crash.connect(e.alice).placeBet(10100n,{value:CREDIT});
    await e.crash.connect(e.bob).placeBet(10100n,{value:CREDIT});
    await closeBetting(e);await e.crash.lockRound();
    expect((await e.crash.rounds(id)).phase).to.equal(1n);
    // Both keys may belong to one economic owner: this gate proves no identity diversity.
  });
  it('a full minimum-size book settles even below the retired pool threshold',async()=>{
    const e=await setup(10n*CREDIT);const id=await e.crash.currentRoundId();
    for(const who of [e.alice,e.bob,e.carol,e.dave])await e.crash.connect(who).placeBet(10100n,{value:CREDIT});
    await expect(e.crash.connect(e.keeper).placeBet(20000n,{value:10n*CREDIT})).to.be.revertedWithCustomError(e.crash,'RoundFull');
    await closeBetting(e);await e.crash.lockRound();
    expect((await e.crash.rounds(id)).phase).to.equal(1n);
    expect(await e.crash.unclaimedRefunds()).to.equal(0n);
  });
  it('an oversized late seat cannot void honest play',async()=>{
    const e=await setup();const id=await e.crash.currentRoundId();
    await e.crash.connect(e.alice).placeBet(20000n,{value:CREDIT});
    await e.crash.connect(e.bob).placeBet(10100n,{value:100n*CREDIT});
    await closeBetting(e);await e.crash.lockRound();
    expect((await e.crash.rounds(id)).phase).to.equal(1n);
    expect(await e.crash.unclaimedRefunds()).to.equal(0n);
    expect(await e.crash.totalOwed()).to.equal(0n);
    expect(await e.lottery.draws()).to.equal(0n);
    expect(await e.crash.accountedBalance()).to.equal(await e.crash.runner.provider.getBalance(e.crash.target));
  });
});
