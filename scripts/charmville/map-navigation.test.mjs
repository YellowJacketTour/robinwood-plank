import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('./display-controls.js',import.meta.url),'utf8')).split('// BEGIN overview navigation')[1].split('// END overview navigation')[0];
function setup(){
 const events={},keys={};let frame;const root={hidden:false,querySelector:()=>null,addEventListener(){}};
 const surface={addEventListener:(k,f)=>events[k]=f,focus:()=>root.activeElement=surface,setPointerCapture(){},getBoundingClientRect:()=>({width:512,height:448})};
 const host={charmvilleMapOpen:true,charmvilleMapNavigationReady:true,addEventListener:(k,f)=>keys[k]=f,requestAnimationFrame:f=>frame=f};
 const context={};vm.runInNewContext(source,context);context.bindMapNavigation(surface,host,root);
 const e=extra=>({preventDefault(){this.prevented=true;},stopImmediatePropagation(){},...extra});
 return {host,root,surface,events,keys,e,tick:t=>frame(t)};
}
test('overview wheel focuses canvas and requests native zoom, never display resize',()=>{const s=setup();s.events.wheel(s.e({deltaY:-80}));assert.equal(s.root.activeElement,s.surface);assert.equal(s.host.charmvilleMapZoomDelta,1);s.host.charmvilleMapOpen=false;s.events.wheel(s.e({deltaY:-80}));assert.equal(s.host.charmvilleMapZoomDelta,1);});
test('drag maps CSS displacement into native display pixels and stops on cancel',()=>{const s=setup();s.events.pointerdown(s.e({button:0,pointerId:1,clientX:50,clientY:50}));s.events.pointermove(s.e({pointerId:1,clientX:90,clientY:70}));assert.equal(s.host.charmvilleMapPanX,20);assert.equal(s.host.charmvilleMapPanY,10);s.events.pointercancel(s.e({pointerId:1}));s.events.pointermove(s.e({pointerId:1,clientX:120,clientY:120}));assert.equal(s.host.charmvilleMapPanX,20);});
test('held WASD pans smoothly and releases on blur; gameplay does not consume keys',()=>{const s=setup();s.surface.focus();s.keys.keydown(s.e({key:'w'}));s.tick(16);assert.equal(s.host.charmvilleMapPanY,4);s.keys.blur();s.tick(32);assert.equal(s.host.charmvilleMapPanY,4);s.host.charmvilleMapOpen=false;const e=s.e({key:'ArrowLeft'});s.keys.keydown(e);assert.equal(e.prevented,undefined);});
