import test from 'node:test';
import assert from 'node:assert/strict';
import {lotteryPopulation,MAX_PHYSICAL_BALLS} from '../../public/arcade/lottery-population.js';
test('every numbered outcome appears exactly once in literal machine populations',()=>{
  for(const n of [1,16,64,96])for(const selected of [1,n]){
    const p=lotteryPopulation(n,selected),labels=[...p.labels,BigInt(selected)];
    assert.equal(p.visible,n);assert.equal(p.sampled,false);assert.equal(new Set(labels).size,n);
    for(let i=1;i<=n;i++)assert.ok(labels.includes(BigInt(i)));
    assert.equal(p.homes.length,n-1);
    for(let i=0;i<p.homes.length;i++){
      const a=p.homes[i];assert.ok(Math.hypot(a[0],a[1]-.89,a[2])+p.radius<1.12);
      for(let j=0;j<i;j++){const b=p.homes[j];assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])>=p.radius*2);}
    }
  }
});
test('huge counts stay bounded and sampled labels remain valid and unique',()=>{
  for(const n of [97n,138n,512n,1000000n,10n**18n])for(const selected of [1n,n]){
    const p=lotteryPopulation(n,selected);
    assert.equal(p.visible,MAX_PHYSICAL_BALLS);assert.equal(p.sampled,true);
    assert.equal(new Set([...p.labels,selected]).size,MAX_PHYSICAL_BALLS);
    assert.ok(p.labels.every((x:bigint)=>x>=1n&&x<=n&&x!==selected));
  }
  assert.equal(lotteryPopulation(0,0).visible,0);
  assert.throws(()=>lotteryPopulation(0,1));assert.throws(()=>lotteryPopulation(16,17));assert.throws(()=>lotteryPopulation(-1,0));
});
