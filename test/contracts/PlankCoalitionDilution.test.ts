import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
const params={floorBps:7500n,houseCapBps:1000n,houseRakeCapBps:5000n,maxVaultBonusBps:2500n,vaultBonusDecayWad:999000000000000000n};
describe('Mixed-coalition dilution counterexamples',()=>{
 it('a small low-target entrant captures the pool when all high-target incumbents bust',async()=>{
  const h=await(await ethers.getContractFactory('PlankCcs2LSettlement')).deploy();
  const unit=10n**18n,stake=10n**15n,Q=unit+stake,D=Q*9550n/10000n,rake=Q-D;
  const seats=[...Array.from({length:20},()=>({stake:unit/20n,targetBps:100000n})),{stake,targetBps:10100n}];
  const early=await h.settle(D,unit,10100n,seats,10n*unit,rake,1000000000n,params);
  const late=await h.settle(D,unit,100000n,seats,10n*unit,rake,1000000000n,params);
  // Exact masses under the 10000-residue crash law: 8900 early, 1000 all survive, 100 all bust.
  const numerator=8900n*(early.playerPayouts[20]+early.bonuses[20])+1000n*(late.playerPayouts[20]+late.bonuses[20]);
  expect(numerator).to.be.greaterThan(8n*unit*1000n); // >0.8 ETH expected gross for 0.001 ETH stake
  expect(early.totalPlayerPaid).to.equal(D);
  expect(early.totalBonus).to.be.at.most(rake/4n);
 });
 it('mixed-round house reward is not bounded by a fraction of the attacker own rake',async()=>{
  const h=await(await ethers.getContractFactory('PlankCcs2LSettlement')).deploy();
  const unit=10n**18n,stake=10n**15n,Q=unit+stake,D=Q*9550n/10000n,rake=Q-D;
  const seats=[...Array.from({length:20},()=>({stake:unit/20n,targetBps:10100n})),{stake,targetBps:30000n}];
  const r=await h.settle(D,unit,30000n,seats,10n*unit,rake,1000000000n,params);
  const expectedBonusNumerator=3333n*r.bonuses[20],ownRake=stake*450n/10000n;
  expect(expectedBonusNumerator).to.be.greaterThan(ownRake*10000n);
  expect(r.totalBonus).to.be.at.most(rake/4n); // aggregate cap remains intact
 });
});
