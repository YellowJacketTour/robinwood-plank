import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitNativeCanvas} from './native-canvas-layout.mjs';
test('fits a uniform integer native frame without changing the world viewport',()=>{
 const source='var VIRTUAL_W = 640; var VIRTUAL_H = 480; bufW: Math.max(VIRTUAL_W, Math.round(cssW * devicePixelRatio)), bufH: Math.max(VIRTUAL_H, Math.round(cssH * devicePixelRatio))';
 const result=fitNativeCanvas(source);assert.match(result,/VIRTUAL_W = 768/);assert.match(result,/VIRTUAL_H = 690/);
 assert.equal(Math.min(768/256,690/(224+6)),3);assert.equal(768-256*3,0);
 assert.throws(()=>fitNativeCanvas('unknown runtime'),/needs review/);
});
