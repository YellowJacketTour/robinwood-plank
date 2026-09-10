import {expect} from 'chai';
import {ethers} from './helpers/hardhat.js';
import {settleCappedPool} from '../../lib/casino/economics-capped-pool.js';
describe('Indexed clearing adversarial arithmetic',()=>{
 it('matches independent sorted clearing across 200 varied books and crash boundaries',async function(){
  this.timeout(180000);
  const h:any=await (await ethers.getContractFactory('PlankStakeIndexHarness')).deploy();
  let seed=421n;const rand=(m:bigint)=>{seed=(seed*48271n)%2147483647n;return seed%m;};
  for(let book=0;book<200;book++){
   const seats=Array.from({length:2+Number(rand(15n))},(_,i)=>({id:String(i),stake:(1n+rand(1000000n))*10000n,targetBps:10100n+rand(99989901n)}));
   if(book%3===0)seats[0].targetBps=10100n;
   const total=seats.reduce((a,s)=>a+s.stake,0n),d=total*9550n/10000n,hWei=rand(total*3n);
   await h.insert(book,seats.map(s=>s.targetBps),seats.map(s=>s.stake/10000n));
   for(const crash of [10000n,seats[0].targetBps-1n,seats[0].targetBps,100000000n]){
    const reference=settleCappedPool(d,hWei,crash,seats);
    const actual=await h.payouts(book,d+hWei,crash,7500n,seats.map(s=>s.stake),seats.map(s=>s.targetBps));
    expect([...actual]).deep.eq(reference.allocations.map(a=>a.payout));
    const c=await h.clear(book,d+hWei,crash,7500n);
    const paid=actual.reduce((a:bigint,b:bigint)=>a+b,0n);
    expect(c.allocated).at.least(paid);expect(c.allocated-paid).lessThan(BigInt(seats.length));
   }
  }
 });
 it('splitting identical-target capital cannot increase payout or change clearing',async()=>{
  const h:any=await (await ethers.getContractFactory('PlankStakeIndexHarness')).deploy();
  await h.insert(1,[10100n,70000n,200000n],[13n,97n,101n]);
  await h.insert(2,[10100n,70000n,70000n,70000n,200000n],[13n,31n,29n,37n,101n]);
  for(const budget of [1582500n,2000000n,10000000n,100000000n]){
   expect(await h.clear(1,budget,200000n,7500n)).deep.eq(await h.clear(2,budget,200000n,7500n));
   const one=await h.payouts(1,budget,200000n,7500n,[970000n],[70000n]);
   const split=await h.payouts(2,budget,200000n,7500n,[310000n,290000n,370000n],[70000n,70000n,70000n]);
   expect(split.reduce((a:bigint,b:bigint)=>a+b,0n)).at.most(one[0]);
  }
 });
 it('accepts arithmetic maxima without overflow and rejects unfunded floors',async()=>{
  const h:any=await (await ethers.getContractFactory('PlankStakeIndexHarness')).deploy();
  await h.insert(0,[100000000n],[10n**29n]);
  const c=await h.clear(0,2n*10n**33n,100000000n,7500n);
  expect(c.allocated).eq(2n*10n**33n);
  await expect(h.clear(0,1n,100000000n,7500n)).revert(ethers);
  await expect(h.insert(0,[100000000n],[1n])).revert(ethers);
 });
});
