import test from 'node:test';
import assert from 'node:assert/strict';
import {pinchMap,wheelZoomFactor} from '../../lib/charmville/map-gesture';
test('wheel units normalize across mouse and trackpad and bound large deltas',()=>{
 assert.equal(wheelZoomFactor(16,0,400),wheelZoomFactor(1,1,400));
 assert.equal(wheelZoomFactor(400,0,400),wheelZoomFactor(1,2,400));
 assert.ok(wheelZoomFactor(-100,0,400)>1);
 assert.ok(wheelZoomFactor(100,0,400)<1);
 assert.equal(wheelZoomFactor(Infinity,0,400),1);
 assert.equal(wheelZoomFactor(100000,0,400),Math.exp(-1));
});
test('pinching preserves the world point beneath the fingers while translating',()=>{
 const start={distance:100,zoom:1,center:{x:30,y:20},midpoint:{x:40,y:20}};
 const current={distance:200,midpoint:{x:60,y:30}};
 const next=pinchMap(start,current,10)!;
 assert.equal(next.zoom,2);
 assert.equal(next.center.x+60/20,30+40/10);
 assert.equal(next.center.y+30/20,20+20/10);
});
test('zoom bounds keep focal math coherent and zero distance is ignored',()=>{
 const start={distance:100,zoom:2,center:{x:30,y:20},midpoint:{x:0,y:0}};
 assert.equal(pinchMap(start,{distance:1000,midpoint:{x:0,y:0}},10)!.zoom,4);
 assert.equal(pinchMap(start,{distance:1,midpoint:{x:0,y:0}},10)!.zoom,1);
 assert.equal(pinchMap({...start,distance:0},{distance:100,midpoint:{x:0,y:0}},10),null);
});
