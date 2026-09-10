import {expect} from 'chai';
import {ethers,networkHelpers} from './helpers/hardhat.js';
import {deployCasino,findRandomness,settleCurrent,assertConserved} from './helpers/casino.js';

describe('Iterative funding, independent of wallet count',()=>{
  it('exposes a funded low-target positive-EV strategy; solvency is not a non-farming guarantee',async()=>{
    const e=await deployCasino({crash:{minStakeWei:1n,emissionBufferCapWei:0n},numberedLottery:true});
    const stake=ethers.parseEther('1');
    await e.crash.fundVault({value:30n*stake});
    await e.lottery.fund({value:stake/5n});
    await e.crash.connect(e.bob).placeBet(10100n,{value:1n});
    await settleCurrent(e,ethers.id('initialize funded lottery board')); // next round commits both funded budgets
    const round=await e.crash.currentRound(),id=await e.crash.currentRoundId();
    const quote=await e.lottery.quote();
    const rake=stake*450n/10000n;
    const count=await e.lottery.ballCountFor(rake,quote.prize);
    expect(count).greaterThan(0n);
    await e.crash.connect(e.alice).placeBetInRound(id,10100n,{value:stake});
    const entropy=await findRandomness(e,id,round.targetDrandRound,c=>c>=10100n);
    await settleCurrent(e,entropy);
    const paid=await e.crash.paidOf(id,e.alice.address);expect(paid).eq(stake*10100n/10000n);
    // 9,900 of the 10,000 crash residues survive 1.01x. The whole-round owner
    // owns the lottery ticket. Linearity of expectation needs no independence.
    // Hash modulo deviations are negligible relative to this strict margin.
    const expectedNumerator=paid*9900n*count+quote.winnerPaid*10000n;
    expect(expectedNumerator).greaterThan(stake*10000n*count);
    await assertConserved(e,expect);
  });
  for(const stake of [10n**12n,10n**24n])it(`each paid round funds both protected principal and spendable rewards at ${stake} wei`,async()=>{
    const e=await deployCasino({crash:{minStakeWei:1n,emissionBufferCapWei:0n},numberedLottery:true});
    await networkHelpers.setBalance(e.alice.address,stake*100n+ethers.parseEther('1'));
    for(let i=0;i<8;i++){
      const round=await e.crash.currentRound(),id=await e.crash.currentRoundId();
      await e.crash.connect(e.alice).placeBetInRound(id,10100n,{value:stake});
      const entropy=await findRandomness(e,id,round.targetDrandRound,c=>i%2===0?c>=10100n:c<10100n);
      await settleCurrent(e,entropy);
      await e.crash.flushRake();
      const allocation=await e.rakeRouter.vaultEscrow();expect(allocation).greaterThan(0n);
      const principalBefore=await e.crash.protectedPrincipal();
      const bufferBefore=await e.crash.buffer();
      await e.rakeRouter.claimVault();
      const addedPrincipal=await e.crash.protectedPrincipal()-principalBefore;
      const addedRewards=await e.crash.buffer()-bufferBefore;
      expect(addedPrincipal).greaterThan(0n);expect(addedRewards).greaterThan(0n);
      expect(addedPrincipal+addedRewards).eq(allocation);
      await e.rakeRouter.claimLottery();
      if(await e.crash.owed(e.alice.address)>0n)await e.crash.connect(e.alice).withdraw();
      expect(await e.crash.protectedPrincipal()).eq(principalBefore+addedPrincipal);
      await assertConserved(e,expect);
    }
  });
});
