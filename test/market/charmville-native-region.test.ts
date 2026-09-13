import test from 'node:test';
import assert from 'node:assert/strict';
import {regionPosition,screenPosition,meadowRegion,meadowRegionGeometry} from '../../lib/charmville/native-region';
import {nativeMaps} from '../../lib/charmville/native-world';
test('screen seam becomes adjacent world pixels rather than a coordinate reset',()=>{
 assert.deepEqual(regionPosition(4,62,255,80),{x:255,y:80});
 assert.deepEqual(regionPosition(4,63,0,80),{x:256,y:80});
 assert.deepEqual(screenPosition(256,80),{dmap:4,screen:63,x:0,y:80});
});
test('every authored cell round trips without changing its identity',()=>{
 for(const s of meadowRegion.screens)for(let y=0;y<s.height*8;y+=8)for(let x=0;x<s.width*8;x+=8){
  const p=regionPosition(s.dmap,s.screen,x,y)!;
  assert.deepEqual(screenPosition(p.x,p.y),{dmap:s.dmap,screen:s.screen,x,y});
 }
});
test('out of bounds and unknown screens cannot become region positions',()=>{
 assert.equal(regionPosition(4,63,256,0),null);assert.equal(regionPosition(4,61,0,0),null);
 assert.equal(screenPosition(512,0),null);assert.equal(screenPosition(0,176),null);assert.equal(screenPosition(NaN,0),null);
});
test('stitched collision accounts for the whole actor footprint across the seam',()=>{
 const footprint=nativeMaps[0].footprint;
 assert.equal(meadowRegionGeometry.width,meadowRegion.width-footprint.width+1);
 for(let y=0;y<meadowRegionGeometry.height;y++)for(let x=0;x<meadowRegionGeometry.width;x++){
  let blocked=false;
  for(let dy=0;dy<footprint.height;dy++)for(let dx=0;dx<footprint.width;dx++)blocked ||= meadowRegion.blocked.has(`${x+dx},${y+dy}`);
  assert.equal(meadowRegionGeometry.blocked.has(`${x},${y}`),blocked,`footprint at ${x},${y}`);
 }
 assert.ok(Array.from({length:meadowRegionGeometry.height},(_,y)=>y).some(y=>!meadowRegionGeometry.blocked.has(`31,${y}`)),'authored seam has at least one passable footprint');
});
