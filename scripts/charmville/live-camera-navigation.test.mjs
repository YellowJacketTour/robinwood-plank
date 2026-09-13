import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('live camera owns WASD but preserves arrows and controller actions',async()=>{
 const source=(await readFile(new URL('./display-controls.js',import.meta.url),'utf8')).split('// BEGIN live camera navigation')[1].split('// END live camera navigation')[0];
 const keys={};let frame;const surface={};const root={activeElement:surface,querySelector:()=>null};const host={charmvilleCameraPanReady:true,addEventListener:(k,f)=>keys[k]=f,requestAnimationFrame:f=>frame=f};const c={};vm.runInNewContext(source,c);c.bindLiveCameraNavigation(surface,host,root);
 const event=key=>({key,preventDefault(){this.blocked=true;},stopImmediatePropagation(){}});
 const arrow=event('ArrowRight');keys.keydown(arrow);assert.equal(arrow.blocked,undefined);
 const w=event('w');keys.keydown(w);frame(16);assert.ok(host.charmvilleCameraPanY<0);assert.equal(w.blocked,true);
 keys.keyup(event('w'));const y=host.charmvilleCameraPanY;frame(32);assert.equal(host.charmvilleCameraPanY,y);
 const pad={...event('d'),charmNativeController:true};keys.keydown(pad);frame(48);assert.equal(pad.blocked,undefined);assert.equal(host.charmvilleCameraPanX,0);
 host.charmvilleMapOpen=true;const d=event('d');keys.keydown(d);assert.equal(d.blocked,undefined);
});
