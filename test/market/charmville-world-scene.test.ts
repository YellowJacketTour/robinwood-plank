import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldScene,followWorldCamera,visibleTerrain} from '../../lib/charmville/world-scene';
import {anchorFromScreen} from '../../lib/charmville/world-coordinates';
const scope={placeId:'home:owner',map:10,epoch:1};
const crop={id:'bed:1',anchor:anchorFromScreen(scope.placeId,10,63,24,88)!,revision:1};
test('camera traversal unloads terrain without destroying or moving crops',()=>{
 const scene=new WorldScene(scope);scene.apply(scope,crop);
 const authored=new Set(Array.from({length:128},(_,s)=>s));
 scene.terrain(followWorldCamera(crop.anchor,{width:256,height:176}),authored);
 const delta=scene.terrain({x:0,y:0,width:256,height:176},authored);
 assert.ok(delta.unload.includes(63));assert.deepEqual(scene.snapshot(),[crop]);
 assert.ok(scene.terrain(followWorldCamera(crop.anchor,{width:256,height:176}),authored).load.includes(63));
 assert.deepEqual(scene.snapshot(),[crop]);
});
test('stale updates cannot resurrect removed entities or leak between places',()=>{
 const scene=new WorldScene(scope);assert.ok(scene.apply(scope,crop));
 assert.ok(scene.remove(scope,crop.id,2));assert.equal(scene.apply(scope,crop),false);
 const next={placeId:'public:meadow',map:10,epoch:2};assert.ok(scene.enter(next));
 assert.equal(scene.apply(scope,{...crop,revision:3}),false);
 assert.equal(scene.enter(scope),false);assert.deepEqual(scene.snapshot(),[]);
 assert.equal(scene.apply(next,{...crop,revision:4}),false);
});
test('camera follows continuously over screen seams and clamps for large screens',()=>{
 const a=followWorldCamera({...crop.anchor,x:511},{width:256,height:176});
 const b=followWorldCamera({...crop.anchor,x:512},{width:256,height:176});
 assert.equal(b.x-a.x,1);
 assert.deepEqual(followWorldCamera(crop.anchor,{width:8000,height:8000}),{x:0,y:0,width:4096,height:1408});
 assert.deepEqual(visibleTerrain({x:0,y:0,width:256,height:176},new Set([0,1,16,17]),0),[0]);
 assert.deepEqual(visibleTerrain({x:3840,y:0,width:256,height:176},new Set([15,16]),0),[15]);
});
