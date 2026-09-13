import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWorldGeometry, isWorldPointBlocked, isWorldFootprintBlocked } from '../../scripts/charmville/compile-world-geometry.mjs';

function fixture(ids = [0, 1, 2, 3]) {
  const topology = { source: {map: 10, dmap: 4}, layout: {columns: 2, rows: 2, screenWidth: 256, screenHeight: 176}, nodes: ids.map(screen => ({screen,sourceX: (screen % 2) * 256,sourceY: Math.floor(screen / 2) * 176})) };
  const terrain = {map: 10,dmap: 4,screens: ids.map(screen => ({screen,layers:[{layer:0,map:10,sourceScreen:screen,cells:Array.from({length:176}, (_,cell) => ({cell,solidity:0}))}]}))};
  return {terrain,topology};
}
test('quadrant bit order is column major, not row major', () => {
  const {terrain,topology}=fixture(); terrain.screens[0].layers[0].cells[0].solidity=2;
  const g=compileWorldGeometry(terrain,topology);
  assert.equal(isWorldPointBlocked(g,0,0),false); assert.equal(isWorldPointBlocked(g,0,8),true);
  assert.equal(isWorldPointBlocked(g,8,0),false); assert.equal(isWorldPointBlocked(g,8,8),false);
});
test('body crosses horizontal and vertical seams without invisible screen-edge walls', () => {
  const {terrain,topology}=fixture(); const g=compileWorldGeometry(terrain,topology);
  assert.equal(isWorldFootprintBlocked(g,248,80),false); assert.equal(isWorldFootprintBlocked(g,80,168),false);
  assert.equal(isWorldFootprintBlocked(g,248,168),false);
  g.chunks[3].solidity[0]=1; assert.equal(isWorldFootprintBlocked(g,248,168),true);
});
test('holes and outside-world space remain blocked', () => {
  const {terrain,topology}=fixture([0,1,2]); const g=compileWorldGeometry(terrain,topology);
  assert.equal(isWorldPointBlocked(g,256,176),true); assert.equal(isWorldFootprintBlocked(g,248,168),true);
  assert.equal(isWorldPointBlocked(g,512,0),true); assert.equal(isWorldPointBlocked(g,-1,0),true);
});
test('preserves every layer and conservatively combines solidity', () => {
  const {terrain,topology}=fixture(); const upper=structuredClone(terrain.screens[0].layers[0]); upper.layer=1; upper.map=11; upper.cells[0].solidity=4; terrain.screens[0].layers.push(upper);
  const g=compileWorldGeometry(terrain,topology); assert.equal(g.chunks[0].layers.length,2);
  assert.equal(g.chunks[0].layers[1].map,11); assert.equal(g.chunks[0].layers[0].solidity[0],0);
  assert.equal(isWorldPointBlocked(g,8,0),true);
});
test('rejects incomplete, duplicate or mismatched exports', () => {
  const a=fixture(); a.terrain.screens[0].layers[0].cells.pop(); assert.throws(()=>compileWorldGeometry(a.terrain,a.topology),/Incomplete/);
  const b=fixture(); b.terrain.map=9; assert.throws(()=>compileWorldGeometry(b.terrain,b.topology),/identity/);
  const c=fixture(); c.terrain.screens.push(c.terrain.screens[0]); assert.throws(()=>compileWorldGeometry(c.terrain,c.topology),/Duplicate/);
});
