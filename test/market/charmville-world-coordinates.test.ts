import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFromScreen,anchorFromRegion,regionFromAnchor,screenFromAnchor,projectAnchor} from '../../lib/charmville/world-coordinates';

test('all source screens round trip independent of region loading',()=>{
 for(let screen=0;screen<128;screen++)for(const [x,y] of [[0,0],[255,175],[128,88]]){
  assert.deepEqual(screenFromAnchor(anchorFromScreen('public:meadow',10,screen,x,y)!),{screen,x,y});
 }
});
test('same crop stays fixed across two different loaded region origins',()=>{
 const crop=anchorFromScreen('home:owner',10,63,24,80);
 assert.deepEqual(anchorFromRegion('home:owner',10,46,2,2,280,256),crop);
 assert.deepEqual(anchorFromRegion('home:owner',10,62,2,1,280,80),crop);
 assert.equal(anchorFromRegion('home:owner',10,15,2,1,0,0),null);
});
test('camera motion changes projection without changing custody or anchor',()=>{
 const crop=Object.freeze(anchorFromScreen('home:owner',10,63,24,80)!);
 assert.deepEqual(projectAnchor(crop,{...crop,x:crop.x-40}),{x:40,y:0});
 assert.equal(projectAnchor(crop,{...crop,placeId:'home:visitor'}),null);
 assert.equal(projectAnchor(crop,{...crop,map:11}),null);
 assert.deepEqual(screenFromAnchor(crop),{screen:63,x:24,y:80});
});

test('inverse region conversion keeps a saved crop fixed when the loaded rectangle changes',()=>{
 const crop=Object.freeze(anchorFromScreen('home:owner',10,63,24,80)!);
 assert.deepEqual(regionFromAnchor(crop,'home:owner',10,46,2,2),{x:280,y:256});
 assert.deepEqual(regionFromAnchor(crop,'home:owner',10,62,2,1),{x:280,y:80});
 assert.equal(regionFromAnchor(crop,'home:visitor',10,46,2,2),null);
 assert.equal(regionFromAnchor(crop,'home:owner',11,46,2,2),null);
 assert.equal(regionFromAnchor(crop,'home:owner',10,0,2,2),null);
 assert.deepEqual(screenFromAnchor(crop),{screen:63,x:24,y:80});
});

test('inverse region bounds include top/left and exclude bottom/right without clamping',()=>{
 const convert=(x:number,y:number)=>regionFromAnchor({placeId:'public:meadow',map:10,x,y},'public:meadow',10,17,2,2);
 assert.deepEqual(convert(256,176),{x:0,y:0});
 assert.deepEqual(convert(767.5,527.5),{x:511.5,y:351.5});
 for(const [x,y] of [[255.5,176],[256,175.5],[768,176],[256,528]])assert.equal(convert(x,y),null);
});

test('inverse region conversion rejects invalid rectangles and invalid source anchors',()=>{
 const anchor=anchorFromScreen('public:meadow',10,127,255,175)!;
 assert.deepEqual(regionFromAnchor(anchor,'public:meadow',10,127,1,1),{x:255,y:175});
 assert.deepEqual(regionFromAnchor(anchor,'public:meadow',10,0,16,8),{x:4095,y:1407});
 for(const [origin,width,height] of [[-1,1,1],[128,1,1],[0.5,1,1],[15,2,1],[112,1,2],[0,17,1],[0,1,9],[0,0,1],[0,1,0],[0,-1,1],[0,1,-1],[0,1.5,1],[0,1,1.5],[NaN,1,1],[0,Infinity,1]]){
  assert.equal(regionFromAnchor(anchor,'public:meadow',10,origin,width,height),null);
 }
 for(const invalid of [{...anchor,x:4096},{...anchor,y:1408},{...anchor,x:-1},{...anchor,y:-1},{...anchor,x:NaN},{...anchor,y:Infinity},{...anchor,placeId:''},{...anchor,map:0},{...anchor,map:1.5}]){
  assert.equal(regionFromAnchor(invalid,invalid.placeId,invalid.map,0,16,8),null);
 }
});

test('all valid source rectangles round trip their corners through world anchors',()=>{
 for(let origin=0;origin<128;origin++)for(let width=1;width<=16-origin%16;width++)for(let height=1;height<=8-Math.floor(origin/16);height++){
  for(const [x,y] of [[0,0],[width*256-0.5,height*176-0.5]]){
   const anchor=anchorFromRegion('public:meadow',10,origin,width,height,x,y)!;
   assert.deepEqual(regionFromAnchor(anchor,'public:meadow',10,origin,width,height),{x,y});
  }
 }
});
