import test from 'node:test';
import assert from 'node:assert/strict';
import {playerLotteryOdds} from '../../public/arcade/lottery-player-odds.js';
test('personal lottery chance includes draw odds and stake share without wallet-count bonuses',()=>{
 for(const unit of [1n,10n**12n,10n**33n]){
  assert.deepEqual(playerLotteryOdds(unit,4n*unit,16n),{numerator:1n,denominator:64n});
  assert.deepEqual(playerLotteryOdds(2n*unit,4n*unit,16n),{numerator:1n,denominator:32n});
  assert.deepEqual(playerLotteryOdds(4n*unit,4n*unit,16n),{numerator:1n,denominator:16n});
 }
 assert.deepEqual(playerLotteryOdds(0n,0n,0n),{numerator:0n,denominator:1n});
 assert.throws(()=>playerLotteryOdds(2n,1n,16n));
});
