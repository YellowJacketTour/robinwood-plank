import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';

type Seat={stake:bigint;targetBps:bigint};
// Independent sorted-breakpoint rational solution, versus the contract's
// iterative elimination. No floating-point monetary calculations.
function reference(budget:bigint,crash:bigint,seats:Seat[]){
 const p=seats.map(s=>s.targetBps<=crash?s.stake*7500n/10000n:0n);
 const active=seats.map((s,i)=>({i,s,room:s.stake*s.targetBps/10000n-p[i]})).filter(x=>x.s.targetBps<=crash);
 active.sort((a,b)=>a.room*b.s.stake<b.room*a.s.stake?-1:a.room*b.s.stake>b.room*a.s.stake?1:0);
 let remaining=budget-p.reduce((a,b)=>a+b,0n),weight=active.reduce((a,x)=>a+x.s.stake,0n);
 while(active.length&&active[0].room*weight<=remaining*active[0].s.stake){const x=active.shift()!;p[x.i]+=x.room;remaining-=x.room;weight-=x.s.stake;}
 for(const x of active)p[x.i]+=remaining*x.s.stake/weight;
 return p;
}
describe('Capped survivor-pool research candidate',()=>{
 it('caps the tiny sole survivor at its chosen X and returns the rest',async()=>{
  const c=await(await ethers.getContractFactory('PlankCappedSurvivorPool')).deploy();
  const s=10n**15n,Q=10n**18n+s,B=Q*9550n/10000n;
  const r=await c.settle(B,10100n,7500n,[{stake:10n**18n,targetBps:100000n},{stake:s,targetBps:10100n}]);
  expect(r.payouts[1]).eq(s*10100n/10000n);expect(r.paid+r.returned).eq(B);expect(r.returned).greaterThan(9n*10n**17n);
 });
 it('redistributes capped allocations so every affordable X is paid',async()=>{
  const c=await(await ethers.getContractFactory('PlankCappedSurvivorPool')).deploy();
  const seats=[{stake:10000n,targetBps:10100n},{stake:10000n,targetBps:30000n}];
  const full=await c.settle(40100n,30000n,7500n,seats);expect([...full.payouts]).deep.eq([10100n,30000n]);
  const limited=await c.settle(30000n,30000n,7500n,seats);expect([...limited.payouts]).deep.eq([10100n,19900n]);
  await expect(c.settle(14999n,30000n,7500n,seats)).revertedWithCustomError(c,'FloorNotFunded');
 });
 it('matches exact rational water filling across mixed portfolios and funding levels',async()=>{
  const c=await(await ethers.getContractFactory('PlankCappedSurvivorPool')).deploy();let seed=81n;
  const rand=(n:bigint)=>{seed=(seed*6364136223846793005n+1n)&((1n<<64n)-1n);return seed%n;};
  for(let k=0;k<300;k++){
   const seats=Array.from({length:1+Number(rand(32n))},()=>({stake:1n+rand(10n**18n),targetBps:10100n+rand(1000000n)}));
   const crash=10100n+rand(1500000n),survivors=seats.filter(s=>s.targetBps<=crash);
   const floors=survivors.reduce((a,s)=>a+s.stake*7500n/10000n,0n),caps=survivors.reduce((a,s)=>a+s.stake*s.targetBps/10000n,0n);
   const budget=floors+rand(caps+1n),r=await c.settle(budget,crash,7500n,seats);
   expect([...r.payouts]).deep.eq(reference(budget,crash,seats));expect(r.paid+r.returned).eq(budget);
   for(let i=0;i<seats.length;i++){const s=seats[i];expect(r.payouts[i]).at.most(s.stake*s.targetBps/10000n);if(s.targetBps<=crash)expect(r.payouts[i]).at.least(s.stake*7500n/10000n);else expect(r.payouts[i]).eq(0n);}
  }
 });
 it('fits the arithmetic candidate within a measured 256-seat gas budget',async()=>{
  const c=await(await ethers.getContractFactory('PlankCappedSurvivorPool')).deploy();
  const seats=Array.from({length:256},(_,i)=>({stake:10n**15n,targetBps:10100n+BigInt(255-i)*1000n}));
  const gas=await c.settle.estimateGas(10n**18n,1000000n,7500n,seats);
  console.log(`capped arithmetic 256-seat gas: ${gas}`);expect(gas).lessThan(12000000n);
 });
});
