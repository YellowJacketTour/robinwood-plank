import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRooms,admittedNativeRoom,connectedNativeRooms} from '../../lib/charmville/native-topology';
import {nativeMaps} from '../../lib/charmville/native-world';

test('trusted rooms exactly match the extracted authoritative geometry set',()=>{
 assert.deepEqual(nativeRooms.map(r=>r.geometryId).sort(),nativeMaps.map(m=>m.id).sort());
 for(const map of nativeMaps)assert.equal(admittedNativeRoom(map.native.dmap,map.native.screen)?.geometryId,map.id);
});
test('only existing two rooms are admitted across the complete source screen range',()=>{
 for(let dmap=0;dmap<=5;dmap++)for(let screen=-1;screen<=128;screen++)
  assert.equal(Boolean(admittedNativeRoom(dmap,screen)),dmap===4&&(screen===62||screen===63));
 for(const screen of [NaN,Infinity,62.5])assert.equal(admittedNativeRoom(4,screen),undefined);
});
test('edges are reciprocal, distinct and reject unregistered adjacent rooms',()=>{
 const west={dmap:4,screen:62},east={dmap:4,screen:63};
 assert.equal(connectedNativeRooms(west,east),true);
 assert.equal(connectedNativeRooms(east,west),true);
 assert.equal(connectedNativeRooms(west,west),false);
 assert.equal(connectedNativeRooms(east,{dmap:4,screen:64}),false);
 assert.equal(connectedNativeRooms({dmap:3,screen:62},east),false);
 assert.equal(Object.isFrozen(nativeRooms),true);
 assert.equal(nativeRooms.every(Object.isFrozen),true);
});
