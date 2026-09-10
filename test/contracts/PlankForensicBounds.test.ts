import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {deployCasino,DEFAULT_LOTTERY} from './helpers/casino.js';
describe('Forensic constructor and recipient boundaries',()=>{
 it('rejects a rake step that would overflow every future rate quote',async()=>{
  const e=await deployCasino(),F=await ethers.getContractFactory('PlankCrash');
  await expect(F.deploy({...e.crashConfig,rakeStepBps:ethers.MaxUint256})).revertedWithCustomError(F,'BadConfig');
  const S=await ethers.getContractFactory('PlankScalableCrash');
  await expect(S.deploy({...e.crashConfig,rakeStepBps:ethers.MaxUint256},10n**20n,10n**18n)).revertedWithCustomError(S,'BadConfig');
 });
 it('rejects a refund timeout whose abandoned deadline cannot be evaluated',async()=>{
  const e=await deployCasino(),F=await ethers.getContractFactory('PlankCrash');
  await expect(F.deploy({...e.crashConfig,refundTimeoutSeconds:ethers.MaxUint256})).revertedWithCustomError(F,'BadConfig');
  const S=await ethers.getContractFactory('PlankScalableCrash');
  await expect(S.deploy({...e.crashConfig,refundTimeoutSeconds:ethers.MaxUint256},10n**20n,10n**18n)).revertedWithCustomError(S,'BadConfig');
 });
 it('rejects a numbered lottery ceiling that quantizes every possible hit to zero',async()=>{
  const [owner]=await ethers.getSigners(),F=await ethers.getContractFactory('PlankCycleLottery');
  await expect(F.deploy({...DEFAULT_LOTTERY,source:owner.address,founderSink:owner.address,oddsOneIn:10n**18n+1n},2000n,10000n,1000n)).revertedWithCustomError(F,'BadConfig');
 });
 it('rejects a bank whitelist entry that can accept value without executing a game',async()=>{
  const [owner]=await ethers.getSigners(),F=await ethers.getContractFactory('PlankBank');
  await expect(F.deploy([owner.address])).revertedWithCustomError(F,'NotAGame');
 });
});
