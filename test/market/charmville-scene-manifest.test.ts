import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileSceneManifest} from '../../lib/charmville/scene-manifest';
import meadow from '../../lib/charmville/geometry/native-adventure-d4-s63.json';
import west from '../../lib/charmville/geometry/native-adventure-d4-s62.json';

// Existing extracted assets only. These fixtures do not register new live rooms.
function fixture(){
 return {version:1,scenes:[west,meadow].map((source,i)=>({
  id:source.id,spaceId:'meadow',floor:0,sourceId:'homestead-template',sourceRoom:`d4/s${62+i}`,
  revision:source.revision,width:source.width,height:source.height,tilePixels:source.tilePixels,
  origin:{x:i*256,y:0},footprint:{...source.footprint},blocked:[...source.blocked],
 })),entrances:[
  {id:'west-east',from:west.id,to:meadow.id,returnId:'meadow-west',trigger:{x:30,y:9},arrival:{x:0,y:9}},
  {id:'meadow-west',from:meadow.id,to:west.id,returnId:'west-east',trigger:{x:0,y:9},arrival:{x:30,y:9}},
 ]};
}

test('source-derived meadow and west pixels round-trip without mixing local coordinates',()=>{
 const scene=compileSceneManifest(fixture());
 for(const local of [{x:0,y:0},{x:24,y:72},{x:255.5,y:175.5}]){
  const world=scene.toWorld(meadow.id,local)!;
  assert.deepEqual(world,{spaceId:'meadow',floor:0,x:256+local.x,y:local.y});
  assert.deepEqual(scene.toLocal(world.spaceId,world.floor,world),{sceneId:meadow.id,...local});
 }
 assert.deepEqual(scene.toLocal('meadow',0,{x:256,y:72}),{sceneId:meadow.id,x:0,y:72});
 assert.equal(scene.toWorld(west.id,{x:256,y:72}),null);
 assert.equal(scene.toWorld(meadow.id,{x:0,y:176}),null);
 assert.equal(scene.toLocal('meadow',0,{x:512,y:72}),null);
 for(const x of [-1,NaN,Infinity])assert.equal(scene.toWorld(west.id,{x,y:0}),null);
 assert.equal(scene.toLocal('another-account-home',0,{x:24,y:72}),null);
 assert.equal(scene.toLocal('meadow',1,{x:24,y:72}),null);
});

test('entrance and return match exact source, cell and inverse destination',()=>{
 const scene=compileSceneManifest(fixture());
 const outward=scene.entranceAt(west.id,'west-east',{x:30,y:9})!;
 assert.deepEqual(outward,{sceneId:meadow.id,cell:{x:0,y:9},returnId:'meadow-west'});
 assert.deepEqual(scene.entranceAt(outward.sceneId,outward.returnId,outward.cell),{sceneId:west.id,cell:{x:30,y:9},returnId:'west-east'});
 assert.equal(scene.entranceAt(west.id,'west-east',{x:29,y:9}),null);
 assert.equal(scene.entranceAt(meadow.id,'west-east',{x:30,y:9}),null);
 assert.equal(scene.entranceAt(west.id,'unknown',{x:30,y:9}),null);
});

test('room floors and spaces remain distinct even with identical rendered coordinates',()=>{
 const input=fixture();
 // Reuse the actual west geometry on another floor only as a projection test.
 input.scenes.push({...structuredClone(input.scenes[0]),id:'projection-test-floor',floor:-1});
 const scene=compileSceneManifest(input);
 assert.equal(scene.toLocal('meadow',0,{x:16,y:72})?.sceneId,west.id);
 assert.equal(scene.toLocal('meadow',-1,{x:16,y:72})?.sceneId,'projection-test-floor');
 assert.equal(scene.toLocal('meadow',-2,{x:16,y:72}),null);
});

test('overlap, duplicate scene/source-room and ambiguous entrance identities are rejected',()=>{
 let input=fixture();input.scenes[1].origin.x=255;assert.throws(()=>compileSceneManifest(input),/overlap/);
 input=fixture();input.scenes[1].id=west.id;assert.throws(()=>compileSceneManifest(input),/Duplicate scene/);
 input=fixture();input.scenes[1].sourceRoom=input.scenes[0].sourceRoom;assert.throws(()=>compileSceneManifest(input),/Duplicate source room/);
 input=fixture();input.entrances[1].id='west-east';assert.throws(()=>compileSceneManifest(input),/Duplicate entrance/);
 input=fixture();input.entrances.push({...input.entrances[0],id:'ambiguous'});assert.throws(()=>compileSceneManifest(input),/Ambiguous entrance/);
});

test('reciprocal entrances cannot silently relocate the return position or room',()=>{
 let input=fixture();input.entrances.pop();assert.throws(()=>compileSceneManifest(input),/reciprocal/);
 input=fixture();input.entrances[1].arrival.y=10;assert.throws(()=>compileSceneManifest(input),/reciprocal/);
 input=fixture();input.entrances[1].returnId='unknown';assert.throws(()=>compileSceneManifest(input),/reciprocal/);
 input=fixture();input.entrances[0].to='missing-room';assert.throws(()=>compileSceneManifest(input),/known distinct/);
});

test('entrance footprint checks all occupied cells and never clamps invalid arrival',()=>{
 let input=fixture();input.scenes[1].blocked.push('1,10');assert.throws(()=>compileSceneManifest(input),/obstructed/);
 input=fixture();input.entrances[0].arrival.x=31;assert.throws(()=>compileSceneManifest(input),/actor bounds/);
 input=fixture();input.entrances[0].arrival.x=.5;assert.throws(()=>compileSceneManifest(input),/out of bounds/);
 input=fixture();input.scenes[0].footprint.width=0;assert.throws(()=>compileSceneManifest(input),/out of bounds/);
});

test('schema rejects unsafe dimensions, malformed revisions and invalid solids',()=>{
 for(const input of [null,[],{version:2}, {version:1,scenes:[],entrances:[]}])assert.throws(()=>compileSceneManifest(input));
 let input=fixture();input.scenes[0].width=Infinity;assert.throws(()=>compileSceneManifest(input),/out of bounds/);
 input=fixture();input.scenes[0].width=65536;input.scenes[0].height=65536;assert.throws(()=>compileSceneManifest(input),/cell budget/);
 input=fixture();input.scenes[0].revision='unverified';assert.throws(()=>compileSceneManifest(input),/SHA256/);
 input=fixture();input.scenes[0].blocked.push('32,0');assert.throws(()=>compileSceneManifest(input),/out-of-bounds/);
 input=fixture();input.scenes[0].blocked.push(input.scenes[0].blocked[0]);assert.throws(()=>compileSceneManifest(input),/Duplicate/);
 input=fixture();input.entrances=[];input.scenes=Array.from({length:5},(_,i)=>({...input.scenes[0],id:`budget-${i}`,sourceRoom:`budget-${i}`,width:1024,height:1024,origin:{x:i*8192,y:0},blocked:[]}));
 assert.throws(()=>compileSceneManifest(input),/total cell budget/);
});

test('compiled geometry owns frozen copies; later input changes cannot move a door',()=>{
 const input=fixture(),scene=compileSceneManifest(input);
 input.scenes[1].origin.x=999;input.entrances[0].arrival.y=999;input.scenes[0].blocked.length=0;
 assert.equal(scene.toWorld(meadow.id,{x:0,y:0})?.x,256);
 assert.equal(scene.entranceAt(west.id,'west-east',{x:30,y:9})?.cell.y,9);
 assert.ok(Object.isFrozen(scene.manifest.scenes[0].blocked));
 assert.ok(Object.isFrozen(scene.manifest.entrances[0].arrival));
});
