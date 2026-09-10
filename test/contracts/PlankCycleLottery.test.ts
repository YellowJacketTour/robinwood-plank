import {expect} from 'chai';
import {ethers,networkHelpers} from './helpers/hardhat.js';
import {DEFAULT_LOTTERY} from './helpers/casino.js';
async function fixture(){
 const [source,winner,other]=await ethers.getSigners();
 const factory=await ethers.getContractFactory('PlankCycleLottery');
 const cfg={...DEFAULT_LOTTERY,source:source.address,founderSink:source.address};
 const lottery:any=await factory.deploy(cfg,2000n,10000n,1000n);
 const seedFor=(hit:boolean,n:bigint)=>{for(let i=1;i<100000;i++){const seed=ethers.toBeHex(i,32);const ball=n-BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','bytes32'],[ethers.id('PLANK_NUMBERED_BALL_V1'),seed])))%n;if((ball===1n)===hit)return seed;}throw Error('seed');};
 return{lottery,source,winner,other,seedFor};
}
describe('Funded lottery cycles',()=>{
 let snapshot:any;beforeEach(async()=>{snapshot=await networkHelpers.takeSnapshot();});afterEach(async()=>{await snapshot.restore();});
 it('snapshot isolates late inflow, win fees reconcile, fresh funding carries and old seed does not age the next cycle',async()=>{
  const {lottery:l,winner,seedFor}=await fixture();
  await l.fund({value:10000n});await l.recordRound(1,ethers.id('init'),winner.address,10000n);
  const before=await l.quoteBreakdown();expect(before.prize).eq(8100n);
  await l.fund({value:1000n});expect(await l.quoteBreakdown()).deep.eq(before);
  const n=await l.ballCountFor(10000n,before.prize);
  await l.recordRound(2,seedFor(true,n),winner.address,10000n);
  expect(await l.owed(winner.address)).eq(before.winnerPaid);
  expect(await l.totalRolloverFees()).eq(before.rolloverFee);
  expect(await l.pool()).eq(before.nextSeed+810n);
  expect(await l.cycleFunding()).eq(810n);expect(await l.cycleId()).eq(2n);
  expect(before.winnerPaid+before.nextSeed+before.rolloverFee).eq(before.prize);
  expect(await ethers.provider.getBalance(await l.getAddress())).eq(await l.accountedBalance());
  await l.connect(winner).withdraw();expect(await l.owed(winner.address)).eq(0n);
  expect(await ethers.provider.getBalance(await l.getAddress())).eq(await l.accountedBalance());
 });
 it('unsuccessful draws earn provisioned fees without draining banked prizes or charging the same funding twice',async()=>{
  const {lottery:l,winner,seedFor}=await fixture();await l.fund({value:10000n});await l.recordRound(1,ethers.id('init'),winner.address,10000n);
  const original=await l.quoteBreakdown(),fees=await l.founderEscrow(),n=await l.ballCountFor(10000n,original.prize);
  for(let id=2;id<22;id++)await l.recordRound(id,seedFor(false,n),winner.address,10000n);
  expect(await l.quoteBreakdown()).deep.eq(original);expect(await l.founderEscrow()).eq(fees+900n);expect(await l.totalDrawRolloverFees()).eq(900n);expect(await l.cycleId()).eq(1n);
 });
 it('splitting funding across callers cannot evade fees or accelerate retention',async()=>{
  const a=await fixture(),b=await fixture();await a.lottery.fund({value:10001n});
  for(let i=0;i<101;i++)await b.lottery.connect(i%2?b.other:b.source).fund({value:i===100?1n:100n});
  for(const key of ['cycleFunding','founderEscrow','fundingFeeRemainder','fundingRolloverRemainder','pendingRolloverFees','pool','retentionBps'])expect(await a.lottery[key]()).eq(await b.lottery[key]());
 });
 it('repeated funded failures earn revenue while the banked pool grows; late provisions wait for their own snapshot',async()=>{
  const {lottery:l,winner,seedFor}=await fixture();await l.fund({value:10000n});await l.recordRound(1,ethers.id('init'),winner.address,10000n);
  let previousPool=await l.pool();
  for(let id=2;id<12;id++){
   const q=await l.quoteBreakdown(),fee=await l.committedRolloverFees(),oldFees=await l.totalDrawRolloverFees();
   await l.fund({value:100n});const afterFunding=await l.pool();expect(afterFunding).greaterThan(previousPool);
   const n=await l.ballCountFor(10000n,q.prize);await l.recordRound(id,seedFor(false,n),winner.address,10000n);
   expect(await l.pool()).eq(afterFunding);expect(await l.totalDrawRolloverFees()).eq(oldFees+fee);expect(fee).greaterThan(0n);
   expect(await l.pendingRolloverFees()).eq(9n);expect(await ethers.provider.getBalance(await l.getAddress())).eq(await l.accountedBalance());previousPool=afterFunding;
  }
 });
 it('rejects unauthorized and repeated draws without changing accounting',async()=>{
  const {lottery:l,winner,other}=await fixture();await l.fund({value:1000n});
  await expect(l.connect(other).recordRound(1,ethers.id('x'),winner.address,1)).revertedWithCustomError(l,'UnauthorizedSource');
  expect(await l.lastRecordedRound()).eq(0n);await l.recordRound(1,ethers.id('x'),winner.address,1);
  await expect(l.recordRound(1,ethers.id('y'),winner.address,1)).revertedWithCustomError(l,'RepeatedRound');
 });
 it('tiny through enormous funding keeps winner majority, exact conservation and bounded actuarial odds',async()=>{
  for(const amount of [1n,11n,10000n,10n**12n,10n**24n,10n**33n]){
   const {lottery:l,winner}=await fixture();await l.fund({value:1n});
   const {networkHelpers}=await import('./helpers/hardhat.js');const [payer]=await ethers.getSigners();await networkHelpers.setBalance(payer.address,amount+ethers.parseEther('10'));
   await l.fund({value:amount});
   await l.recordRound(1,ethers.id('init'),winner.address,1n);const q=await l.quoteBreakdown();
   expect(q.winnerPaid*10000n).at.least(q.prize*7500n);expect(q.winnerPaid+q.nextSeed+q.rolloverFee).eq(q.prize);
   for(const rake of [1n,10000n,10n**18n]){const count=await l.ballCountFor(rake,q.prize);if(count>0n)expect((q.winnerPaid+q.rolloverFee)*20000n).at.most(((rake*2600n/10000n)*9000n/10000n*9000n/10000n)*10000n*count);}
  }
 });
});
