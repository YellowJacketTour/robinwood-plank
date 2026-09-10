import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRatio,createResolutionGovernor} from '../../public/arcade/render-budget.js';
test('high-density phones and large screens stay inside the GPU pixel budget',()=>{
 for(const [w,h,dpr] of [[390,844,3],[430,932,3],[3840,2160,2],[393,511,1.5]]){
  const ratio=renderRatio(w,h,dpr);assert.ok(w*h*ratio*ratio<=1500001);assert.ok(ratio<=1.5);
 }
});
test('resolution recovers slowly and ignores tab-resume gaps',()=>{
 const governor=createResolutionGovernor();
 for(let i=0;i<100;i++)governor.sample(1/30);
 assert.equal(governor.cap,1.35);
 governor.sample(20);assert.equal(governor.cap,1.35);
 for(let i=0;i<200;i++)governor.sample(1/60);
 assert.equal(governor.cap,1.35);
 for(let i=0;i<1500;i++)governor.sample(1/60);
 assert.equal(governor.cap,1.5);
 for(let i=0;i<2000;i++)governor.sample(1/20);
 assert.equal(governor.cap,.75);
});
