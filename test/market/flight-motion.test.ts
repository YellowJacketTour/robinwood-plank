import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser ESM module
import {advanceFlightMotion} from '../../public/arcade/flight-motion.js';
test('altitude and velocity agree across 2 FPS and 120 FPS',()=>{
  function run(fps:number){let s={position:0,velocity:0};for(let i=0;i<fps*2;i++)s=advanceFlightMotion(s.position,s.velocity,1,1/fps);return s;}
  const slow=run(2),fast=run(120);assert.ok(Math.abs(slow.position-fast.position)<1e-12);assert.ok(Math.abs(slow.velocity-fast.velocity)<1e-12);assert.ok(slow.position>.999);
});
test('a long frame remains finite and converges without overshoot',()=>{
  const s=advanceFlightMotion(0,0,1,20);assert.equal(s.position,1);assert.ok(Number.isFinite(s.velocity));
});
test('invalid time samples are rejected',()=>{for(const t of [-1,NaN,Infinity])assert.throws(()=>advanceFlightMotion(0,0,1,t),RangeError);});
