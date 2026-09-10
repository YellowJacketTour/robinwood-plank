import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptClaim,freeCollateral,quoteClaim,settleClaims,winningResidues,type Budget} from '../../lib/casino/research/funded-crash-claims';
const unit=10n**18n;
function bank():Budget{return {assets:1000n*unit,protectedVault:800n*unit,protectedLottery:100n*unit,fees:0n,owed:0n,reservedClaims:0n};}
test('one thousand adversarial portfolios preserve floors at the maximum common crash',()=>{
 let state=1234567n;
 for(let run=0;run<1000;run++){
  let b=bank();const claims=[];
  for(let i=0;i<64;i++){state=(state*48271n)%2147483647n;const stake=10n**12n*(1n+state%10000n),target=10100n+state%99989900n,c=quoteClaim(stake,target);
   try{b=acceptClaim(b,c,450n);claims.push(c);}catch(e){assert.match(String(e),/Insufficient/);}
  }
  const before=b;b=settleClaims(b,claims,100000000n);assert.ok(freeCollateral(b)>=0n);assert.equal(b.protectedVault,before.protectedVault);assert.equal(b.protectedLottery,before.protectedLottery);assert.equal(b.reservedClaims,0n);
 }
});
test('existing payout cannot be diluted by any subsequently admitted claimant',()=>{
 let b=bank();const first=quoteClaim(unit,20000n);b=acceptClaim(b,first,450n);
 for(let i=0;i<20;i++)b=acceptClaim(b,quoteClaim(unit/100n,1000000n),450n);
 assert.equal(first.payout,2n*unit);assert.ok(freeCollateral(b)>=0n);
});
test('wallet splitting cannot improve a fixed economic position',()=>{
 for(const target of [10100n,20000n,27182n,1000000n])for(const factor of [7500n,9550n,10000n]){
  const stake=unit+123n,whole=quoteClaim(stake,target,factor).payout;
  for(const count of [2n,7n,64n]){const part=stake/count,remainder=stake%count;const split=(count-1n)*quoteClaim(part,target,factor).payout+quoteClaim(part+remainder,target,factor).payout;assert.ok(split<=whole);}
 }
});
test('every target and portfolio obeys the same conditional expected-return bound',()=>{
 for(const edge of [0n,250n,450n])for(const factor of [7500n,9550n,10000n])for(let target=10100n;target<=100000000n;target=target*107n/100n+1n){
  const stake=unit+37n,c=quoteClaim(stake,target,factor),mass=winningResidues(target,edge);
  assert.ok(c.payout*mass*10000n<=stake*factor*(10000n-edge));
 }
});
test('protected reserves cannot authorize an otherwise unfunded high target',()=>{
 const b=bank();assert.throws(()=>acceptClaim(b,quoteClaim(unit,100000000n),450n),/Insufficient/);assert.deepEqual(b,bank());
});
