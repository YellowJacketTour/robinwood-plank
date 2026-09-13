import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureGameplay} from './gameplay-capture.mjs';
function fixture(){
 const track=new EventTarget();track.readyState='live';let stops=0;
 track.stop=()=>{stops++;track.readyState='ended';};
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
 const canvas=new EventTarget();canvas.width=256;canvas.height=232;canvas.captureStream=()=>stream;
 return {canvas,track,stream,stops:()=>stops};
}
test('ending capture releases its video track exactly once',()=>{
 const f=fixture(),reasons=[];const capture=captureGameplay(f.canvas,{onStop:r=>reasons.push(r)});
 assert.equal(capture.stream,f.stream);assert.equal(f.track.contentHint,'detail');
 capture.stop();capture.stop();assert.equal(f.stops(),1);assert.equal(capture.active,false);assert.deepEqual(reasons,['stopped']);
});
test('rendering loss terminates publication source',()=>{
 const f=fixture(),reasons=[];const capture=captureGameplay(f.canvas,{onStop:r=>reasons.push(r)});
 f.canvas.dispatchEvent(new Event('webglcontextlost'));
 assert.equal(capture.active,false);assert.equal(f.stops(),1);assert.deepEqual(reasons,['rendering-interrupted']);
});
test('capture refuses unexpected audio or extra tracks',()=>{
 const f=fixture();let extraStopped=false;
 f.stream.getTracks=()=>[f.track,{stop(){extraStopped=true;}}];
 assert.throws(()=>captureGameplay(f.canvas),/game-only/);assert.equal(extraStopped,true);assert.equal(f.stops(),1);
});
test('unsupported and tainted canvas failures never fall back to broader capture',()=>{
 assert.throws(()=>captureGameplay({}),/not supported/);
 const f=fixture();f.canvas.captureStream=()=>{throw Error('tainted');};
 assert.throws(()=>captureGameplay(f.canvas),/No other screen/);
 assert.throws(()=>captureGameplay(f.canvas,{frameRate:120}),/frame rate/);
});

test('unsupported content hints do not leak or prevent capture',()=>{
 const f=fixture();Object.defineProperty(f.track,'contentHint',{set(){throw Error('unsupported');}});
 const capture=captureGameplay(f.canvas);capture.stop();assert.equal(f.stops(),1);
});

test('2D rendering loss and externally ended tracks terminate capture',()=>{
 for(const event of ['contextlost','ended']){
  const f=fixture();const capture=captureGameplay(f.canvas);
  (event==='ended'?f.track:f.canvas).dispatchEvent(new Event(event));
  assert.equal(capture.active,false);assert.equal(f.stops(),1);
 }
});

function audioFixture(f){
 const audio=new EventTarget();audio.kind='audio';audio.readyState='live';let stopped=0;
 audio.stop=()=>{stopped++;audio.readyState='ended';};
 const context=new EventTarget();context.state='running';
 const destination={stream:{getTracks:()=>[audio]}};
 context.createMediaStreamDestination=()=>destination;
 const connections=[],disconnections=[];
 const output={context,connect:node=>connections.push(node),disconnect:node=>disconnections.push(node)};
 const tracks=[f.track];f.stream.getTracks=()=>tracks;
 f.stream.addTrack=item=>tracks.push(item);
 return {audio,context,destination,output,connections,disconnections,stops:()=>stopped};
}

test('game audio branches into capture and teardown preserves speaker connection',()=>{
 const f=fixture(),a=audioFixture(f);
 const capture=captureGameplay(f.canvas,{audioOutput:a.output});
 assert.equal(capture.hasGameAudio,true);assert.equal(capture.stream.getTracks().length,2);
 assert.deepEqual(a.connections,[a.destination]);capture.stop();capture.stop();
 assert.deepEqual(a.disconnections,[a.destination]);assert.equal(a.stops(),1);assert.equal(f.stops(),1);
});

test('audio attachment failure closes both capture tracks without stopping the engine',()=>{
 const f=fixture(),a=audioFixture(f);f.stream.addTrack=()=>{throw Error('failed');};
 assert.throws(()=>captureGameplay(f.canvas,{audioOutput:a.output}),/No microphone/);
 assert.equal(a.stops(),1);assert.equal(f.stops(),1);
 assert.deepEqual(a.disconnections,[a.destination]);assert.equal(a.context.state,'running');
});

test('audio shutdown ends capture and a suspended game refuses silent audio attachment',()=>{
 const f=fixture(),a=audioFixture(f);const capture=captureGameplay(f.canvas,{audioOutput:a.output});
 a.context.state='closed';a.context.dispatchEvent(new Event('statechange'));
 assert.equal(capture.active,false);assert.equal(f.stops(),1);assert.equal(a.stops(),1);
 const g=fixture(),b=audioFixture(g);b.context.state='suspended';
 assert.throws(()=>captureGameplay(g.canvas,{audioOutput:b.output}),/audio could not/);
 assert.equal(g.stops(),1);assert.equal(b.connections.length,0);
});
