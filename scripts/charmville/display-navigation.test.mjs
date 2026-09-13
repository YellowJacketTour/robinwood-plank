import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./display-controls.js',import.meta.url),'utf8');
function setup(){
 const context={TouchEvent:class{constructor(type,data){Object.assign(this,{type},data);}}};vm.runInNewContext(source.split('// BEGIN native display navigation')[1].split('// END native display navigation')[0],context);
 const events={},keys={};let zoom=1,modal=null,ready=true;
 const cancelled=[];
 const canvas={clientHeight:400,dispatchEvent:event=>cancelled.push(event),addEventListener:(type,fn,options)=>{events[type]=fn;assert.equal(options.passive,false);}};
 const root={activeElement:canvas,querySelector:()=>modal};
 context.bindDisplayNavigation(canvas,{addEventListener:(type,fn)=>{keys[type]=fn;}},root,()=>zoom,v=>{zoom=v;},()=>ready);
 const event=extra=>({target:canvas,type:'keydown',preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra});
 return {events,keys,root,canvas,event,cancelled,zoom:()=>zoom,setModal:v=>{modal=v;},setReady:v=>{ready=v;}};
}
test('wheel changes supplied camera zoom and consumes the event',()=>{
 const s=setup(),e=s.event({deltaY:-100,deltaMode:0});s.events.wheel(e);
 assert.ok(s.zoom()>1);assert.ok(e.prevented&&e.stopped);
 s.setModal({});const old=s.zoom();s.events.wheel(s.event({deltaY:100,deltaMode:0}));assert.equal(s.zoom(),old);
});
test('pinch changes camera zoom; unavailable renderer does not consume gestures',()=>{
 const s=setup();const touches=n=>[{clientX:0,clientY:0},{clientX:n,clientY:0}];
 s.events.touchstart(s.event({touches:touches(100)}));
 s.events.touchmove(s.event({touches:touches(150)}));assert.equal(s.zoom(),1.5);
 assert.equal(s.cancelled[0].type,'touchcancel');
 s.events.touchcancel(s.event({touches:[]}));s.events.touchmove(s.event({touches:touches(200)}));assert.equal(s.zoom(),1.5);
 s.setReady(false);const e=s.event({deltaY:-100,deltaMode:0});s.events.wheel(e);assert.equal(e.prevented,undefined);assert.equal(s.zoom(),1.5);
});
test('focused zoom keys are isolated but movement, shortcuts and form input remain native',()=>{
 const s=setup();s.keys.keydown(s.event({key:'+'}));assert.equal(s.zoom(),1.1);
 s.keys.keyup(s.event({type:'keyup',key:'+'}));assert.equal(s.zoom(),1.1);
 s.keys.keydown(s.event({key:'0'}));assert.equal(s.zoom(),1);
 for(const extra of [{key:'ArrowUp'},{key:'z'},{key:'+',ctrlKey:true},{key:'+',target:{tagName:'INPUT'}}]){const e=s.event(extra);s.keys.keydown(e);assert.equal(e.prevented,undefined);assert.equal(s.zoom(),1);}
 s.root.activeElement={};const e=s.event({key:'+',target:s.root});s.keys.keydown(e);assert.equal(e.prevented,undefined);
});
test('zoom owns its matching key release when a menu opens mid-press',()=>{
 const s=setup();s.keys.keydown(s.event({key:'+'}));s.setModal({});
 const release=s.event({type:'keyup',key:'+'});s.keys.keyup(release);assert.equal(release.prevented,true);
 const nativeRelease=s.event({type:'keyup',key:'ArrowUp'});s.keys.keyup(nativeRelease);assert.equal(nativeRelease.prevented,undefined);
});
