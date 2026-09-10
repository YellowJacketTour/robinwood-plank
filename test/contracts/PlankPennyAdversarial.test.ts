import { expect } from 'chai';
import { ethers } from './helpers/hardhat.js';

describe('Penny-tier adversarial settlement bounds', function () {
  this.timeout(120000);
  const params={floorBps:7500n,houseCapBps:1000n,houseRakeCapBps:5000n,maxVaultBonusBps:2500n,vaultBonusDecayWad:999000000000000000n};
  it('conserves every wei and cannot subsidize a sole economic owner into profit, even after a billion rounds', async () => {
    const harness=await (await ethers.getContractFactory('PlankCcs2LSettlement')).deploy();
    for(const stake of [1n,1000000000000n,1000000000000000000n])
      for(const count of [1,2,16,128])
        for(const target of [10100n,20000n,1000000n])
          for(const age of [0n,1000n,1000000000n]) {
            const pool=stake*BigInt(count),rake=pool*450n/10000n,seed=10n**18n;
            const seats=Array.from({length:count},()=>({stake,targetBps:target}));
            const result=await harness.settle(pool-rake,seed,target,seats,10n**24n,rake,age,params);
            expect(result.totalPlayerPaid+result.totalBonus+result.houseReturned+result.bustedToReserve).to.equal(pool-rake+seed);
            expect(result.totalPlayerPaid+result.totalBonus).to.be.at.most(pool);
            expect(result.totalBonus).to.be.at.most(rake*2500n/10000n);
          }
  });
  it('wallet splitting cannot increase aggregate same-target bonus', async () => {
    const harness=await (await ethers.getContractFactory('PlankCcs2LSettlement')).deploy();
    const pool=128n*10n**12n,rake=pool*450n/10000n,seed=10n**18n;
    const single=await harness.settle(pool-rake,seed,20000n,[{stake:pool,targetBps:20000n}],10n**24n,rake,1000000000n,params);
    for(const count of [2,4,16,128]) {
      const split=await harness.settle(pool-rake,seed,20000n,Array.from({length:count},()=>({stake:pool/BigInt(count),targetBps:20000n})),10n**24n,rake,1000000000n,params);
      expect(split.totalPlayerPaid).to.equal(single.totalPlayerPaid);
      expect(split.totalBonus).to.be.at.most(single.totalBonus);
    }
  });
  it('a crash below every penny target returns all reserved funding without a payout', async () => {
    const harness=await (await ethers.getContractFactory('PlankCcs2LSettlement')).deploy();
    const stake=10n**12n,rake=stake*450n/10000n,seed=10n**18n;
    const result=await harness.settle(stake-rake,seed,10000n,[{stake,targetBps:10100n}],10n**24n,rake,1000000000n,params);
    expect(result.totalPlayerPaid+result.totalBonus).to.equal(0n);
    expect(result.bustedToReserve).to.equal(stake-rake+seed);
  });
});
