import test from 'node:test';
import assert from 'node:assert/strict';
import {numberedLotteryBudget,LOTTERY_PROBABILITY_SCALE as ONE} from '../../lib/casino/numbered-lottery';
test('numbered candidate never raises the funded probability and uses the smallest safe N',()=>{
  const thresholds=[0n,1n,2n,ONE/4n,38_425_000_000_000_000n,ONE];
  for(let n=2n;n<1000n;n++)thresholds.push(ONE/n-1n,ONE/n,ONE/n+1n);
  for(const threshold of thresholds){const {ballCount,winningNumber}=numberedLotteryBudget(threshold);
    if(threshold===0n){assert.equal(ballCount,0n);assert.equal(winningNumber,null);continue;}
    assert.ok(ballCount*threshold>=ONE);assert.ok((ballCount-1n)*threshold<ONE);assert.equal(winningNumber,1n);
  }
  assert.equal(numberedLotteryBudget(38_425_000_000_000_000n).ballCount,27n);
});
test('budget inequality survives prize scale and arbitrary round partitioning',()=>{
  let oldExpectedNumerator=0n,newExpectedUpperNumerator=0n;
  for(let i=1n;i<=1000n;i++){
    const threshold=(i*7919n)%250_000_000_000_000_000n+1n;
    const prize=(i**5n)*10n**12n;const n=numberedLotteryBudget(threshold).ballCount;
    // Cross-multiply the exact rational EVs; do not floor payouts into a false proof.
    assert.ok(prize*ONE<=prize*threshold*n);
    oldExpectedNumerator+=prize*threshold;
    newExpectedUpperNumerator+=(prize*ONE+n-1n)/n;
  }
  assert.ok(newExpectedUpperNumerator<=oldExpectedNumerator+1000n);
});
test('invalid inputs cannot create an accidental guaranteed draw',()=>{
  assert.throws(()=>numberedLotteryBudget(-1n));assert.throws(()=>numberedLotteryBudget(ONE+1n));
});
