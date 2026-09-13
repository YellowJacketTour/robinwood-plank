import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {parseAnimationXml,readAnimationSheets} from './animation-source.mjs';
const physical='<Anim><Name>Attack</Name><FrameWidth>2</FrameWidth><FrameHeight>2</FrameHeight><Durations><Duration>6</Duration></Durations></Anim>';
const alias=(name,target)=>`<Anim><Name>${name}</Name><CopyOf>${target}</CopyOf></Anim>`;
const xml=anims=>`<AnimData><ShadowSize>1</ShadowSize><Anims>${anims}</Anims></AnimData>`;
test('aliases resolve physical frames without claiming gameplay moves',()=>{
 const result=parseAnimationXml(xml(physical+alias('Shoot','Attack')));
 assert.equal(result.animations[1].sourceAnimation,'Attack');
 assert.deepEqual(result.animations[1].durations,[6]);
 assert.deepEqual(result.animations[0].markers.effective,{rush:0,return:0,hit:0});
});
test('cycles, missing aliases and unsupported chains fail closed',()=>{
 assert.throws(()=>parseAnimationXml(xml(alias('A','B')+alias('B','A'))),/cycle/);
 assert.throws(()=>parseAnimationXml(xml(alias('A','Missing'))),/Missing/);
 assert.throws(()=>parseAnimationXml(xml(physical+alias('A','Attack')+alias('B','A'))),/chains/);
});
test('invalid frame dimensions, markers and duplicate animations rejected',()=>{
 assert.throws(()=>parseAnimationXml(xml(physical.replace('<FrameWidth>2','<FrameWidth>3'))),/even/);
 assert.throws(()=>parseAnimationXml(xml(physical.replace('</Anim>','<HitFrame>9</HitFrame></Anim>'))),/HitFrame/);
 assert.throws(()=>parseAnimationXml(xml(physical+physical)),/duplicate/);
});
function png(points=[]){const image=new PNG({width:2,height:2});image.data.fill(0);for(const [x,y,color]of points)image.data.set(color,(y*2+x)*4);return PNG.sync.write(image);}
test('frame-local anchors preserve overlapping channels and head fallback',()=>{
 const animation=parseAnimationXml(xml(physical)).animations[0];
 const sheets={anim:png(),offsets:png([[0,0,[255,255,0,255]],[1,1,[0,0,255,255]]]),shadow:png([[0,1,[255,255,255,255]]])};
 const frame=readAnimationSheets(animation,sheets).frames[0];
 assert.deepEqual(frame.body,{x:0,y:0});assert.deepEqual(frame.red,frame.body);assert.deepEqual(frame.head,frame.body);assert.equal(frame.headFallback,true);assert.deepEqual(frame.shadow,{x:0,y:1});
 sheets.offsets=png([[0,0,[0,255,0,255]],[1,0,[0,255,0,255]]]);
 assert.throws(()=>readAnimationSheets(animation,sheets),/Ambiguous body/);
});
