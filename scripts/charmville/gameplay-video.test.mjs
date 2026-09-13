import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountGameplayVideo} from './gameplay-video.mjs';

function fixture() {
  const el = () => Object.assign(new EventTarget(), {style:{},isConnected:true,classList:{contains:()=>false},remove(){this.isConnected=false;}});
  const button=el(),status=el(),video=el(),panel=el(),canvas=el(),view=el();
  panel.open=true;
  let resolvePlay,rejectPlay,stops=0,observer,disconnected=false;
  video.play=()=>new Promise((resolve,reject)=>{resolvePlay=resolve;rejectPlay=reject;});
  video.pause=()=>{};
  panel.querySelector=s=>s==='button'?button:s==='video'?video:status;
  const track=el();track.readyState='live';track.stop=()=>{stops++;track.readyState='ended';};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  canvas.width=256;canvas.height=232;canvas.captureStream=()=>stream;
  let pending=false,currentCanvas=canvas;
  view.MutationObserver=class {constructor(callback){observer=callback;}observe(){}disconnect(){disconnected=true;}};
  const root={createElement:()=>panel,defaultView:view,documentElement:el(),body:el(),querySelector:s=>s==='canvas'?currentCanvas:s==='.charm-runtime-enter'&&pending?{}:null};
  const dispose=mountGameplayVideo(root,{append(){}});
  return {button,status,video,canvas,view,track,panel,dispose,stops:()=>stops,disconnected:()=>disconnected,
    click:()=>button.dispatchEvent(new Event('click')),flush:()=>new Promise(resolve=>setImmediate(resolve)),
    finish:()=>resolvePlay(),fail:()=>rejectPlay(Error('Playback denied')),change:()=>{pending=true;observer();},replace:()=>{currentCanvas=el();observer();},observe:()=>observer()};
}

test('stop during pending playback prevents stale success or error updates',async()=>{
  const f=fixture();f.click();f.click();f.finish();await f.flush();
  assert.equal(f.stops(),1);assert.equal(f.status.textContent,'Video is off.');assert.equal(f.video.srcObject,null);
  f.dispose();
});
test('disposal invalidates unresolved playback and detaches observers',async()=>{
  const f=fixture();f.click();f.dispose();f.fail();await f.flush();
  assert.equal(f.stops(),1);assert.equal(f.video.hidden,true);assert.equal(f.disconnected(),true);
  f.click();assert.equal(f.stops(),1);
});
test('admission restart ends capture even when canvas still exists',()=>{
  const f=fixture();f.click();f.change();
  assert.equal(f.stops(),1);assert.equal(f.video.srcObject,null);assert.match(f.status.textContent,/being prepared/);
  f.click();assert.match(f.status.textContent,/arrive first/);f.dispose();
});
test('engine canvas replacement and page exit release capture',()=>{
  const f=fixture();f.click();f.replace();assert.equal(f.stops(),1);f.dispose();
  const g=fixture();g.click();g.view.dispatchEvent(new Event('pagehide'));assert.equal(g.stops(),1);g.dispose();
});
test('rendering loss clears the preview and playback failure stops the track',async()=>{
  const f=fixture();f.click();f.canvas.dispatchEvent(new Event('contextlost'));
  assert.equal(f.stops(),1);assert.match(f.status.textContent,/Rendering stopped/);f.dispose();
  const g=fixture();g.click();g.fail();await g.flush();assert.equal(g.stops(),1);assert.equal(g.status.textContent,'Playback denied');g.dispose();
});
test('removing the preview panel tears down its listeners and stream',()=>{
  const f=fixture();f.click();f.panel.remove();f.observe();assert.equal(f.stops(),1);assert.equal(f.disconnected(),true);
});
