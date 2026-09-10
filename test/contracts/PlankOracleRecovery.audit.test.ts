import {expect} from 'chai';
import {ethers,networkHelpers} from './helpers/hardhat.js';

describe('Oracle outage and minimum-output adversarial regressions',()=>{
 async function setup(rate=10n){
  const [owner]=await ethers.getSigners();
  const token=await ethers.getContractFactory('MockERC20Burnable');
  const weth=await token.deploy(),plank=await token.deploy();
  const r=ethers.parseEther('100');
  const pair=await(await ethers.getContractFactory('MockV2Pair')).deploy(await weth.getAddress(),await plank.getAddress(),r,r*rate);
  const oracle=await(await ethers.getContractFactory('PlankV2TwapOracle')).deploy(await pair.getAddress(),30,60,1);
  const router=await(await ethers.getContractFactory('MockV2Router')).deploy(await plank.getAddress(),100);
  const engine=await(await ethers.getContractFactory('PlankBurnEngine')).deploy(await plank.getAddress(),await router.getAddress(),await weth.getAddress(),await oracle.getAddress(),ethers.parseEther('1'),0,500);
  await owner.sendTransaction({to:await engine.getAddress(),value:ethers.parseEther('1')});
  await networkHelpers.time.increase(31);await oracle.update();
  return{owner,weth,plank,pair,oracle,router,engine,r};
 }
 it('cannot freshen an obsolete average after an outage to execute a discounted community burn',async()=>{
  const e=await setup();await networkHelpers.time.increase(6000);
  await e.pair.setReserves(e.r,e.r*1000n);await networkHelpers.time.increase(31);
  await e.oracle.update();
  const before=await ethers.provider.getBalance(await e.engine.getAddress());
  await expect(e.engine.executeBurn(ethers.parseEther('0.1'))).revertedWithCustomError(e.oracle,'NotInitialized');
  expect(await ethers.provider.getBalance(await e.engine.getAddress())).eq(before);
  expect(await e.engine.totalEthSpent()).eq(0n);
  await networkHelpers.time.increase(31);await e.oracle.update();
  await expect(e.engine.executeBurn(ethers.parseEther('0.1'))).revertedWith('INSUFFICIENT_OUTPUT_AMOUNT');
  await e.router.setPlankOutPerWei(1000);
  await e.engine.executeBurn(ethers.parseEther('0.1'));
  expect(await e.engine.totalPlankBurned()).eq(ethers.parseEther('100'));
 });
 it('refuses a swap whose integer minimum output is zero',async()=>{
  const e=await setup(1n);
  // One wei fair output rounds to zero after the slippage allowance.
  await expect(e.engine.executeBurn(1n)).revertedWithCustomError(e.engine,'ZeroFairFloor');
  expect(await e.engine.totalEthSpent()).eq(0n);
 });
 it('does not mistake a whole uint32 timestamp wrap for a fresh short interval',async()=>{
  const snapshot=await networkHelpers.takeSnapshot();
  try{
   const e=await setup();await networkHelpers.time.increase(2**32+31);
   await e.oracle.update();
   await expect(e.oracle.consult(await e.weth.getAddress(),1n)).revertedWithCustomError(e.oracle,'NotInitialized');
  }finally{await snapshot.restore();}
 });
});
