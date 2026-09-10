import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTargetBps} from '../../public/arcade/target-input.js';
test('visible target maps exactly to its contract commitment without a risky fallback',()=>{
  for(const [text,bps] of [['1.01',10100n],['2',20000n],['1.10',11000n],['99.99',999900n],['10000',100000000n]] as const)assert.equal(parseTargetBps(text),bps);
  for(const text of ['', '1','1.00','1.001','1.011','-2','NaN','Infinity','1e2','10000.01'])assert.equal(parseTargetBps(text),null,text);
  assert.equal(parseTargetBps('2',19999n),null);
});
