import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeMaps,crossNativeBorder,nativeMapGeometry} from '../../lib/charmville/native-world';
import {spawnActor} from '../../lib/charmville/native-action-domain';
test('every exported western crossing has a collision-safe reciprocal arrival',()=>{
 const [farm,west]=nativeMaps;
 for(let y=4;y<=12;y++){
  const start=spawnActor(nativeMapGeometry(farm),{x:0,y},5,0);
  const away=crossNativeBorder(start,farm,west.id,100);
  assert.deepEqual(away.state.cell,{x:30,y});assert.equal(away.state.regionEpoch,6);
  const back=crossNativeBorder(away.state,west,farm.id,200);
  assert.deepEqual(back.state.cell,start.cell);assert.equal(back.state.regionEpoch,7);
 }
});
test('travel rejects shortcuts, unconnected maps and rapid border bouncing',()=>{
 const [farm,west]=nativeMaps;const start=spawnActor(nativeMapGeometry(farm),{x:0,y:9},0,0);
 assert.throws(()=>crossNativeBorder(start,farm,west.id,99),/fast/);
 assert.throws(()=>crossNativeBorder({...start,cell:{x:1,y:9}},farm,west.id,100),/border/);
 assert.throws(()=>crossNativeBorder(start,farm,'invented',100),/Unconnected/);
 assert.throws(()=>crossNativeBorder({...start,cell:{x:0,y:13}},farm,west.id,100),/border/);
});
